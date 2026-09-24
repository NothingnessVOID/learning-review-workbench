// Browser regression on an isolated demo instance supplied by scripts/e2e.mjs.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const base = process.env.UI_TEST_URL;
if (!base || /:47831(?:\/|$)/.test(base))
  throw Error("UI_TEST_URL must identify an isolated demo service");
const output = fileURLToPath(
  new URL("../artifacts/ui-regression/", import.meta.url),
);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
    ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
    : {}),
});
const context = await browser.newContext({
  viewport: { width: 1280, height: 900 },
});
const page = await context.newPage();
const consoleErrors = [];
page.on("pageerror", (error) => consoleErrors.push(error.message));
await context.tracing.start({
  screenshots: true,
  snapshots: true,
  sources: true,
});
let failed = false;
const marker = `UIREG-${Date.now()}`;
const pause = () => {
  let release;
  const promise = new Promise((resolve) => (release = resolve));
  return { promise, release };
};
const waitFor = async (predicate) => {
  for (let i = 0; i < 80; i++) {
    if (predicate()) return;
    await page.waitForTimeout(25);
  }
  throw Error("intercept not reached");
};
const storage = (key) =>
  page.evaluate((key) => JSON.parse(localStorage.getItem(key) || "null"), key);
try {
  await page.goto(base + "/#courses");
  await page.getByText("独立演示资料").waitFor();
  await page
    .locator(".course-row")
    .filter({ hasText: "留下一句" })
    .first()
    .click();
  await page.locator(".topic-link").first().click();
  await page.waitForURL(/#topic\//);
  await page.locator(".teaching-block").first().waitFor();
  const topicUrl = page.url();
  const topicTitle = await page.locator("#main h1").innerText();
  // U01: entering a short topic and leaving before the scroll debounce still records it.
  await page.getByRole("button", { name: "返回课程地图" }).click();
  await page.goto(base + "/#courses");
  await page.getByRole("button", { name: /继续阅读/ }).click();
  assert.equal(page.url(), topicUrl);
  await page.reload();
  await page.locator("#main h1").waitFor();
  assert.equal(await page.locator("#main h1").innerText(), topicTitle);
  // E02: focus cycles inside dialog and returns to the opener.
  const opener = page.getByRole("button", { name: /记一句/ }).first();
  await opener.click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  assert.match(
    await page.locator(".relation-chip").innerText(),
    new RegExp(topicTitle.slice(0, 8)),
  );
  await page.keyboard.press("Shift+Tab");
  assert.equal(
    await page.evaluate(
      () => document.activeElement?.closest('[role="dialog"]') !== null,
    ),
    true,
  );
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  assert.equal(
    await opener.evaluate((el) => document.activeElement === el),
    true,
  );
  // R02/U04: A submitted, B edited while request is pending, B stays and gets a new ID.
  await opener.click();
  const quick = page.locator("#quick-text");
  await quick.fill(`${marker} A`);
  const a = await storage("workbench.quick-draft");
  const held = pause();
  let intercepted = false;
  await page.route("**/api/rpc", async (route) => {
    const body = JSON.parse(route.request().postData() || "{}");
    if (
      body.tool === "create_note" &&
      body.args.original_text === `${marker} A`
    ) {
      intercepted = true;
      await held.promise;
    }
    await route.continue();
  });
  await page.getByRole("button", { name: "保存记录" }).click();
  await waitFor(() => intercepted);
  await quick.fill(`${marker} B`);
  const b = await storage("workbench.quick-draft");
  assert.notEqual(b.requestId, a.requestId);
  held.release();
  await page.getByText("上一版已保存，新输入仍留在草稿中").waitFor();
  assert.equal((await storage("workbench.quick-draft")).text, `${marker} B`);
  await page.unroute("**/api/rpc");
  await page.getByRole("button", { name: "保存记录" }).click();
  await page.getByText("记录已保存").waitFor();
  await page.goto(base + "/#notes");
  await page.getByText(`${marker} A`).waitFor();
  await page.getByText(`${marker} A`).click();
  const noteId = page.url().split("/").at(-1);
  await page.getByText(topicTitle).waitFor(); // resolved relation is visible.
  // R02 remount: old feedback response cannot erase B typed in a new NotePage instance.
  const feedback = page.locator('textarea[placeholder="后来……"]');
  await feedback.fill(`${marker} feedback A`);
  const heldFeedback = pause();
  let feedbackIntercepted = false;
  await page.route("**/api/rpc", async (route) => {
    const body = JSON.parse(route.request().postData() || "{}");
    if (
      body.tool === "create_note" &&
      body.args.original_text === `${marker} feedback A`
    ) {
      feedbackIntercepted = true;
      await heldFeedback.promise;
    }
    await route.continue();
  });
  await page.getByRole("button", { name: "保存后续反馈" }).click();
  await waitFor(() => feedbackIntercepted);
  await page.goto(base + "/#courses");
  await page.goto(base + `/#note/${noteId}`);
  await page
    .locator('textarea[placeholder="后来……"]')
    .fill(`${marker} feedback B`);
  const feedbackB = await storage(`workbench.feedback.${noteId}`);
  heldFeedback.release();
  await page.waitForTimeout(450);
  assert.deepEqual(await storage(`workbench.feedback.${noteId}`), feedbackB);
  await page.unroute("**/api/rpc");
  await page.getByRole("button", { name: "保存后续反馈" }).click();
  await page.getByText(`${marker} feedback B`).waitFor();
  const reviewInput = page.locator(
    'textarea[placeholder="粘贴外部复盘结果（Markdown 可用）"]',
  );
  await reviewInput.fill(`${marker} review A`);
  const heldReview = pause();
  let reviewIntercepted = false;
  await page.route("**/api/rpc", async (route) => {
    const body = JSON.parse(route.request().postData() || "{}");
    if (
      body.tool === "save_review_result" &&
      body.args.body_md === `${marker} review A`
    ) {
      reviewIntercepted = true;
      await heldReview.promise;
    }
    await route.continue();
  });
  await page.getByRole("button", { name: "保存这次复盘" }).click();
  await waitFor(() => reviewIntercepted);
  await reviewInput.fill(`${marker} review B`);
  const reviewB = await storage(`workbench.review.${noteId}`);
  heldReview.release();
  await page.getByText("上一版复盘已归档，新输入仍留在草稿中").waitFor();
  assert.deepEqual(await storage(`workbench.review.${noteId}`), reviewB);
  await page.unroute("**/api/rpc");
  await page.getByRole("button", { name: "保存这次复盘" }).click();
  await page.getByText(`${marker} review B`).waitFor();
  // U05: 160 same-term notes span several pages; reach the oldest one.
  const sessionResponse = await fetch(base + "/api/session");
  const cookie = sessionResponse.headers.get("set-cookie")?.split(";")[0] || "";
  const { csrf } = await sessionResponse.json();
  async function rpc(tool, args) {
    const r = await fetch(base + "/api/rpc", {
      method: "POST",
      headers: {
        cookie,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      body: JSON.stringify({ tool, args }),
    });
    const result = await r.json();
    assert.equal(result.ok, true, `${tool}: ${JSON.stringify(result.error)}`);
    return result.data;
  }
  for (let i = 0; i < 160; i++)
    await rpc("create_note", {
      original_text: `${marker} older ${String(i).padStart(3, "0")}`,
      type: "quick",
      relation_ids: [],
      client_request_id: crypto.randomUUID(),
    });
  const oldResult = await rpc("search_library", {
    query: `${marker} older 000`,
    types: ["note"],
    limit: 40,
  });
  assert.equal(oldResult.items.length, 1);
  const olderId = oldResult.items[0].id;
  const secondNote = (
    await rpc("search_library", {
      query: `${marker} B`,
      types: ["note"],
      limit: 40,
    })
  ).items.find((item) => item.title === `${marker} B`);
  assert.ok(secondNote, "second quick note must be searchable");
  const secondDetail = await rpc("get_note", { note_id: secondNote.id });
  assert.ok(
    secondDetail.relation_ids.includes(topicUrl.split("/").at(-1)),
    "second quick note must retain topic relation",
  );
  assert.ok(
    secondDetail.resolved_relations?.some(
      (item) => item.id === topicUrl.split("/").at(-1),
    ),
    "direct relation must be readable",
  );
  await page.goto(base + "/#notes");
  for (
    let i = 0;
    i < 20 &&
    !(await page
      .locator(".timeline-item")
      .filter({ hasText: `${marker} older 000` })
      .count());
    i++
  ) {
    const button = page.getByRole("button", { name: "加载更早记录" });
    await button.waitFor();
    const count = await page.locator(".timeline-item").count();
    await button.click();
    await page.waitForFunction(
      (previous) =>
        document.querySelectorAll(".timeline-item").length > previous,
      count,
    );
  }
  assert.ok((await page.locator(".timeline-item").count()) >= 160);
  assert.equal(
    await page
      .locator(".timeline-item")
      .filter({ hasText: `${marker} older 000` })
      .count(),
    1,
  );
  const today = new Date().toISOString().slice(0, 10);
  await page.locator('.filters input[type="date"]').first().fill(today);
  await page.locator('.filters input[type="date"]').last().fill(today);
  await page
    .locator(".timeline-item")
    .filter({ hasText: `${marker} older 159` })
    .first()
    .waitFor();
  await page.goto(base + `/#search?q=${encodeURIComponent(marker)}`);
  for (
    let i = 0;
    i < 20 &&
    ((await page.locator(".result-row").count()) < 160 ||
      !(await page
        .locator(".result-row")
        .filter({ hasText: `${marker} older 159` })
        .count()));
    i++
  ) {
    const button = page.getByRole("button", { name: "加载更多结果" });
    await button.waitFor();
    const count = await page.locator(".result-row").count();
    await button.click();
    await page.waitForFunction(
      (previous) => document.querySelectorAll(".result-row").length > previous,
      count,
    );
  }
  assert.ok((await page.locator(".result-row").count()) >= 160);
  assert.equal(
    await page
      .locator(".result-row")
      .filter({ hasText: `${marker} older 000` })
      .count(),
    1,
  );
  await page.locator('.filters input[type="date"]').first().fill(today);
  await page.locator('.filters input[type="date"]').last().fill(today);
  await page.locator(".result-row").first().waitFor();
  assert.match(
    await page.locator(".result-row").first().innerText(),
    new RegExp(marker),
  );
  await page.goto(base + "/#settings");
  await page
    .locator(".note-permissions .permission-list label")
    .first()
    .waitFor();
  const firstPageCount = await page
    .locator(".note-permissions .permission-list label")
    .count();
  assert.equal(firstPageCount, 40);
  for (
    let i = 0;
    i < 30 &&
    !(await page
      .locator(".note-permissions .permission-list label")
      .filter({ hasText: `${marker} older 000` })
      .count());
    i++
  ) {
    const button = page
      .locator(".note-permissions")
      .getByRole("button", { name: "加载更多记录" });
    await button.waitFor();
    const count = await page
      .locator(".note-permissions .permission-list label")
      .count();
    await button.click();
    await page.waitForFunction(
      (previous) =>
        document.querySelectorAll(".note-permissions .permission-list label")
          .length > previous,
      count,
    );
  }
  assert.ok(
    (await page.locator(".note-permissions .permission-list label").count()) >=
      160,
  );
  await page
    .locator(".note-permissions .permission-list label")
    .filter({ hasText: `${marker} older 000` })
    .getByRole("checkbox")
    .check();
  await page.getByRole("button", { name: "保存权限" }).click();
  await page.getByText("MCP 权限已保存").waitFor();
  assert.ok(
    (await rpc("get_status", {})).permissions.read_note_ids.includes(olderId),
  );
  // R01: changing share invalidates a completed download and an in-flight response.
  await page.locator("select").last().selectOption("notes");
  await page
    .locator(".export-pick-list label")
    .filter({ hasText: `${marker} older 000` })
    .getByRole("checkbox")
    .check();
  const exportResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/rpc") &&
      JSON.parse(response.request().postData() || "{}").tool === "export_data",
  );
  await page.getByRole("button", { name: "生成导出预览" }).click();
  const generated = (await exportResponse).json();
  assert.deepEqual((await generated).data.parameters.ids, [olderId]);
  await page.locator(".preview-box .download-link").waitFor();
  await page.getByRole("checkbox", { name: /生成分享版本/ }).check();
  assert.equal(await page.locator(".preview-box .download-link").count(), 0);
  const heldExport = pause();
  let exportIntercepted = false;
  await page.route("**/api/rpc", async (route) => {
    const body = JSON.parse(route.request().postData() || "{}");
    if (body.tool === "export_data") {
      exportIntercepted = true;
      await heldExport.promise;
    }
    await route.continue();
  });
  await page.getByRole("button", { name: "生成导出预览" }).click();
  await waitFor(() => exportIntercepted);
  await page
    .locator('textarea[placeholder="例如姓名、账号或地点"]')
    .fill(marker);
  heldExport.release();
  await page.waitForTimeout(450);
  assert.equal(await page.locator(".preview-box .download-link").count(), 0);
  await page.unroute("**/api/rpc");
  await page.getByRole("button", { name: "生成导出预览" }).click();
  await page.locator(".preview-box .download-link").waitFor();
  assert.match(
    await page
      .locator(".preview-box")
      .filter({ has: page.locator(".download-link") })
      .innerText(),
    /分享版/,
  );
  // U09: only explicit original and related records are in the handoff.
  await page.goto(base + `/#note/${noteId}`);
  await page
    .getByRole("textbox", { name: "查找相关记录" })
    .fill(`${marker} older 000`);
  await page.locator('.handoff-options input[type="checkbox"]').first().check();
  await page.getByRole("checkbox", { name: "附上可定位的来源原文" }).check();
  const handoffResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/rpc") &&
      JSON.parse(response.request().postData() || "{}").tool ===
        "get_review_handoff",
  );
  await page.getByRole("button", { name: "预览交接内容" }).click();
  const handoffData = (await (await handoffResponse).json()).data;
  assert.deepEqual(handoffData.selected.related_note_ids, [olderId]);
  assert.equal(handoffData.selected.include_sources, true);
  assert.match(
    await page.locator(".handoff-preview").innerText(),
    new RegExp(`${marker} A`),
  );
  assert.match(
    await page.locator(".handoff-preview").innerText(),
    new RegExp(`${marker} older 000`),
  );
  assert.doesNotMatch(
    await page.locator(".handoff-preview").innerText(),
    new RegExp(`${marker} older 001`),
  );
  // E01: actual computed colors for representative auxiliary text exceed WCAG 4.5:1.
  await page.goto(base + "/#courses");
  const contrast = await page.evaluate(() => {
    const rgb = (value) =>
      value
        .match(/[\d.]+/g)
        .slice(0, 3)
        .map(Number);
    const lum = (value) => {
      const values = rgb(value).map((v) => {
        v /= 255;
        return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      });
      return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
    };
    const background = (el) => {
      for (let node = el; node; node = node.parentElement) {
        const color = getComputedStyle(node).backgroundColor;
        if (color !== "rgba(0, 0, 0, 0)" && color !== "transparent")
          return color;
      }
      return getComputedStyle(document.body).backgroundColor;
    };
    return [
      ".small-muted",
      ".course-date",
      ".row-kicker",
      ".row-summary",
      ".section-heading > span",
      ".eyebrow",
    ].map((selector) => {
      const el = document.querySelector(selector);
      const fg = getComputedStyle(el).color,
        bg = background(el),
        a = lum(fg),
        b = lum(bg);
      return {
        selector,
        fg,
        bg,
        ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
      };
    });
  });
  for (const item of contrast)
    assert.ok(
      item.ratio >= 4.5,
      `${item.selector} contrast ${item.ratio.toFixed(2)} ${item.fg} on ${item.bg}`,
    );
  console.log(
    "E01 computed contrast:",
    contrast
      .map(
        (item) =>
          `${item.selector} ${item.ratio.toFixed(2)}:1 ${item.fg} on ${item.bg}`,
      )
      .join("; "),
  );
  // E02: offscreen sidebar is inert at mobile size, opens with focus and closes back to menu.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(
    () => document.querySelector(".sidebar")?.inert === true,
  );
  assert.equal(await page.locator(".sidebar").evaluate((el) => el.inert), true);
  const menu = page.getByRole("button", { name: "打开菜单" });
  await menu.click();
  await page.waitForFunction(
    () => document.querySelector(".sidebar")?.inert === false,
  );
  assert.equal(
    await page.locator(".sidebar").evaluate((el) => el.inert),
    false,
  );
  await page.keyboard.press("Escape");
  await page.waitForFunction(
    () => document.querySelector(".sidebar")?.inert === true,
  );
  assert.equal(await page.locator(".sidebar").evaluate((el) => el.inert), true);
  assert.equal(
    await menu.evaluate((el) => document.activeElement === el),
    true,
  );
  await page.goto(base + "/#settings");
  await page.getByRole("heading", { name: "让资料留在自己的掌握中" }).waitFor();
  await page.waitForFunction(() => {
    const sidebar = document.querySelector(".sidebar");
    return (
      sidebar?.inert &&
      sidebar.getBoundingClientRect().right <= 0 &&
      !document.querySelector(".drawer-scrim")
    );
  });
  await page.screenshot({
    path: output + "mobile-settings.png",
    fullPage: true,
  });
  assert.deepEqual(consoleErrors, []);
  console.log("UI regression passed: R01 R02 U01 U04 U05 E02");
} catch (error) {
  failed = true;
  await page
    .screenshot({ path: output + "failure.png", fullPage: true })
    .catch(() => {});
  console.error(error);
  process.exitCode = 1;
} finally {
  await context.tracing.stop({
    path: output + (failed ? "failure-trace.zip" : "trace.zip"),
  });
  await browser.close();
}
