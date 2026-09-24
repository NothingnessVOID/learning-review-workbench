// Run against the isolated demo service only: node scripts/ui-test.mjs
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const base = process.env.UI_TEST_URL || "http://127.0.0.1:47832";
if (base.includes(":47831"))
  throw new Error("Refusing to write UI test data to the private service.");
const output = new URL("../artifacts/screenshots/", import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
    ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
    : {}),
});
const errors = [];
const context = await browser.newContext();
await context.tracing.start({ screenshots: true, snapshots: true });
let page;
try {
  page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      !message.location().url.endsWith("/favicon.ico") &&
      !(
        message.location().url.endsWith("/api/rpc") &&
        message.text().includes("net::ERR_FAILED")
      )
    )
      errors.push(message.text());
  });
  await page.goto(`${base}/#courses`);
  await page.getByText("独立演示资料").waitFor();
  assert.equal(await page.locator("h1").innerText(), "继续学习，从这里开始");
  await page.screenshot({
    path: fileURLToPath(new URL("1280-courses.png", output)),
    fullPage: true,
  });

  await page
    .locator(".course-row")
    .filter({ hasText: "留下一句" })
    .first()
    .click();
  await page.locator(".topic-link").first().click();
  await page
    .getByRole("button", { name: /查看出处/ })
    .first()
    .click();
  await page.getByRole("dialog").waitFor();
  assert.match(await page.getByRole("dialog").innerText(), /版本/);
  await page.getByRole("button", { name: "关闭原文" }).click();
  const sourceButtons = page.locator(".block-sources button");
  await sourceButtons
    .nth(Math.min(5, (await sourceButtons.count()) - 1))
    .click();
  await page.getByRole("button", { name: /查看前文/ }).waitFor();
  await page.getByRole("button", { name: /查看前文/ }).click();
  if (await page.getByRole("button", { name: /继续展开后文/ }).count())
    await page.getByRole("button", { name: /继续展开后文/ }).click();
  await page.getByRole("button", { name: "关闭原文" }).click();

  await page.evaluate(() => window.scrollTo(0, 500));
  await page.waitForTimeout(1200);
  const topicUrl = page.url();
  await page.goto(`${base}/#courses`);
  await page.getByRole("button", { name: /继续阅读/ }).click();
  await page.waitForTimeout(550);
  assert.equal(page.url(), topicUrl);
  assert.ok(
    (await page.evaluate(() => window.scrollY)) >= 250,
    "reading position was not restored",
  );

  const sentence = `DEMO UI 失败重试验收 ${Date.now()}`;
  await page.getByRole("button", { name: /写下我的理解/ }).click();
  await page.locator("#quick-text").fill(sentence);
  const before = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("workbench.quick-draft")),
  );
  await page.route("**/api/rpc", async (route) => {
    const payload = JSON.parse(route.request().postData() || "{}");
    if (payload.tool === "create_note") await route.abort();
    else await route.continue();
  });
  await page.getByRole("button", { name: "保存记录" }).click();
  await page.getByText("保存失败，草稿已留在本机").waitFor();
  const failed = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("workbench.quick-draft")),
  );
  assert.equal(failed.text, sentence);
  assert.equal(failed.requestId, before.requestId);
  await page.unroute("**/api/rpc");
  await page.reload();
  await page
    .getByRole("button", { name: /记一句/ })
    .first()
    .click();
  assert.equal(await page.locator("#quick-text").inputValue(), sentence);
  const reloaded = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("workbench.quick-draft")),
  );
  assert.equal(reloaded.requestId, before.requestId);
  await page.getByRole("button", { name: "保存记录" }).click();
  await page.getByText("记录已保存").waitFor();
  await page.goto(`${base}/#notes`);
  await page.getByText(sentence).waitFor();
  assert.equal(await page.getByText(sentence).count(), 1);

  await page.getByText(sentence).click();
  const noteId = page.url().split("/").at(-1);
  const topicId = topicUrl.split("/").at(-1);
  await page.locator('textarea[placeholder="后来……"]').fill("DEMO UI 后续反馈");
  await page.getByRole("button", { name: "保存后续反馈" }).click();
  await page.getByText("DEMO UI 后续反馈").waitFor();
  await page
    .locator('textarea[placeholder="粘贴外部复盘结果（Markdown 可用）"]')
    .fill("DEMO UI 复盘结果，保留原话。");
  await page.getByRole("button", { name: "保存这次复盘" }).click();
  await page.getByText("DEMO UI 复盘结果，保留原话。").waitFor();
  await page.getByRole("button", { name: "归档这条记录" }).click();
  await page.goto(`${base}/#notes`);
  await page.getByRole("checkbox", { name: "含已归档" }).check();
  await page.getByText(sentence).waitFor();
  await page.getByText(sentence).click();
  await page.getByRole("button", { name: "恢复这条记录" }).click();
  await page.goto(`${base}/#notes`);
  await page.getByText(sentence).waitFor();

  const sessionResponse = await fetch(`${base}/api/session`);
  const session = await sessionResponse.json();
  const cookie = sessionResponse.headers.get("set-cookie")?.split(";")[0] || "";
  const relation = await fetch(`${base}/api/rpc`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": session.csrf,
      Cookie: cookie,
    },
    body: JSON.stringify({
      tool: "propose_relations",
      args: {
        relations: [
          {
            from_id: noteId,
            to_id: topicId,
            kind: "learning_note",
            reason: "DEMO UI 关联审核验收",
          },
        ],
        client_request_id: crypto.randomUUID(),
      },
    }),
  }).then((r) => r.json());
  assert.equal(relation.ok, true, "could not create demo relation");

  await page.goto(`${base}/#drafts`);
  await page.locator(".draft-row").first().click();
  await page.locator(".draft-readable").first().waitFor();
  assert.ok((await page.locator(".draft-readable").count()) > 0);
  assert.equal(await page.locator(".raw-diff").getAttribute("open"), null);
  await page.goto(`${base}/#drafts`);
  await page.getByText("DEMO UI 关联审核验收").waitFor();
  await page
    .locator(".relation-review-row")
    .filter({ hasText: "DEMO UI 关联审核验收" })
    .getByRole("button", { name: "确认关联" })
    .click();
  await page.getByText("DEMO UI 关联审核验收").waitFor({ state: "detached" });

  await page.goto(`${base}/#settings`);
  await page.locator("select").last().selectOption("notes");
  await page.locator(".export-pick-list input").first().check();
  await page.getByRole("button", { name: "生成导出预览" }).click();
  await page.locator(".preview-box .download-link").waitFor();

  await page.goto(`${base}/#import`);
  await page.locator("input[type=file]").setInputFiles({
    name: "DEMO-ui-smoke.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("DEMO UI 导入样本。\n资料只用于演示。"),
  });
  await page.getByRole("button", { name: "预览导入" }).click();
  await page.locator(".count-grid").waitFor();
  await page.getByRole("button", { name: "确认导入" }).click();
  await page.locator(".result-pre").waitFor();

  for (const [width, route, file] of [
    [768, "topic", "768-topic.png"],
    [390, "notes", "390-notes.png"],
  ]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${base}/#${route === "topic" ? "courses" : route}`);
    if (route === "topic") {
      await page
        .locator(".course-row")
        .filter({ hasText: "留下一句" })
        .first()
        .click();
      await page.locator(".topic-link").first().click();
    }
    await page.waitForTimeout(200);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth),
      width,
      `${width}px layout overflow`,
    );
    await page.screenshot({
      path: fileURLToPath(new URL(file, output)),
      fullPage: true,
    });
  }
  assert.deepEqual(errors, []);
  console.log(
    "UI smoke passed: reading, source context, position, failure retry, timeline, archive restore, relation review, draft, export, import, 1280/768/390 screenshots.",
  );
} catch (error) {
  await mkdir(new URL("../artifacts/ui-regression/", import.meta.url), {
    recursive: true,
  });
  if (page)
    await page.screenshot({
      path: fileURLToPath(
        new URL(
          "../artifacts/ui-regression/smoke-failure.png",
          import.meta.url,
        ),
      ),
      fullPage: true,
    });
  await context.tracing.stop({
    path: fileURLToPath(
      new URL("../artifacts/ui-regression/smoke-trace.zip", import.meta.url),
    ),
  });
  throw error;
} finally {
  await browser.close();
}
