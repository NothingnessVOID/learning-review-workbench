// B03/B06/B09 browser regression. Always starts a disposable seeded server.
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { project, session, startTestServer } from "./test-server.mjs";

const output = join(project, "artifacts", "handoff-regression");
await mkdir(output, { recursive: true });
const server = await startTestServer();
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
    ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
    : {}),
});
const context = await browser.newContext({
  viewport: { width: 1280, height: 900 },
});
await context.grantPermissions(["clipboard-read", "clipboard-write"]);
const page = await context.newPage();
await context.tracing.start({
  screenshots: true,
  snapshots: true,
  sources: true,
});
const marker = `HANDOFF-${Date.now()}`;
let failed = false;

function holdRpc(tool, predicate = () => true) {
  let release;
  let reached;
  const reachedPromise = new Promise((resolve) => {
    reached = resolve;
  });
  const releasePromise = new Promise((resolve) => {
    release = resolve;
  });
  const handler = async (route) => {
    const body = JSON.parse(route.request().postData() || "{}");
    if (body.tool === tool && predicate(body.args || {})) {
      reached(body.args);
      await releasePromise;
    }
    await route.continue().catch(() => {});
  };
  return { handler, reached: reachedPromise, release: () => release() };
}
async function rpc(client, tool, args = {}) {
  const result = await client.rpc(tool, args);
  assert.equal(result.ok, true, `${tool}: ${JSON.stringify(result.error)}`);
  return result.data;
}
async function chooseRelated(value) {
  await page.getByRole("textbox", { name: "查找相关记录" }).fill(value);
  const option = page
    .locator('.handoff-options input[type="checkbox"]')
    .first();
  await option.waitFor();
  await option.check();
  return option;
}
async function assertNoHandoff() {
  assert.equal(await page.locator(".handoff-preview").count(), 0);
  assert.equal(
    await page.getByRole("button", { name: "复制交接内容" }).count(),
    0,
  );
  assert.equal(
    await page.getByRole("button", { name: "下载交接文件" }).count(),
    0,
  );
}

try {
  const client = await session(server.base);
  const source = [
    `# ${marker} 来源`,
    ...Array.from(
      { length: 10 },
      (_, index) =>
        `## 段落 ${index + 1}\n${marker} 来源段落 ${index + 1}，原文保留。`,
    ),
    `## 长段\n${"说明此段需要完整回查。".repeat(1600)}`,
    ...Array.from(
      { length: 3 },
      (_, index) =>
        `## 后段 ${index + 1}\n${marker} 后段 ${index + 1}，原文保留。`,
    ),
  ].join("\n\n");
  const preview = await rpc(client, "preview_import", {
    files: [
      {
        name: `${marker}.md`,
        content_base64: Buffer.from(source).toString("base64"),
      },
    ],
    source_kind: "other",
    series: `${marker} 隔离来源`,
  });
  const imported = await rpc(client, "commit_import", {
    preview_id: preview.id,
  });
  const courseId = imported.imported[0].course_id;
  const noteA = await rpc(client, "create_note", {
    original_text: `${marker} 主记录 A`,
    type: "event",
    occurred_at: "2026-09-23T16:10:00.000Z",
    relation_ids: [courseId],
    client_request_id: crypto.randomUUID(),
  });
  const noteB = await rpc(client, "create_note", {
    original_text: `${marker} 相关记录 B`,
    type: "event",
    client_request_id: crypto.randomUUID(),
  });
  const noteC = await rpc(client, "create_note", {
    original_text: `${marker} 未选记录 C`,
    type: "event",
    client_request_id: crypto.randomUUID(),
  });
  const oldReview = await rpc(client, "save_review_result", {
    note_ids: [noteA.id],
    body_md: `${marker} 先前复盘正文`,
    method_name: "演示方法",
    client_request_id: crypto.randomUUID(),
  });
  const relatedReview = await rpc(client, "save_review_result", {
    note_ids: [noteB.id],
    body_md: `${marker} 相关记录的旧复盘`,
    client_request_id: crypto.randomUUID(),
  });
  const feedback = await rpc(client, "create_note", {
    original_text: `${marker} 后续反馈正文`,
    type: "feedback",
    parent_note_id: noteA.id,
    client_request_id: crypto.randomUUID(),
  });
  const relatedFeedback = await rpc(client, "create_note", {
    original_text: `${marker} 相关记录的后续反馈`,
    type: "feedback",
    parent_note_id: noteB.id,
    client_request_id: crypto.randomUUID(),
  });
  await rpc(client, "create_note", {
    original_text: `${marker} 子记录但非反馈`,
    type: "quick",
    parent_note_id: noteB.id,
    client_request_id: crypto.randomUUID(),
  });

  // B09: keyboard typing goes directly to the quick editor; focus is trapped and restored.
  const seeded = await rpc(client, "list_courses", { limit: 1 });
  const course = await rpc(client, "get_course", {
    course_id: seeded.items[0].id,
  });
  await page.goto(`${server.base}/#topic/${course.topics[0].id}`);
  await page.getByRole("button", { name: "写下我的理解" }).waitFor();
  const opener = page.getByRole("button", { name: /记一句/ }).first();
  await opener.click();
  await page.getByRole("dialog").waitFor();
  assert.equal(
    await page.evaluate(() => document.activeElement?.id),
    "quick-text",
  );
  await page.keyboard.type(`${marker} 键盘直写`);
  assert.equal(
    await page.locator("#quick-text").inputValue(),
    `${marker} 键盘直写`,
  );
  await page.keyboard.press("Shift+Tab");
  assert.equal(
    await page.evaluate(
      () => !!document.activeElement?.closest('[role="dialog"]'),
    ),
    true,
  );
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "detached" });
  assert.equal(
    await opener.evaluate((element) => document.activeElement === element),
    true,
  );
  await page.getByRole("button", { name: "写下我的理解" }).click();
  assert.equal(
    await page.locator("#quick-text").inputValue(),
    `${marker} 键盘直写`,
  );
  await page.locator("#quick-text").fill("");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "写下我的理解" }).click();
  assert.equal(
    await page.getByRole("dialog").locator("select").inputValue(),
    "understanding",
  );
  await page.keyboard.press("Escape");

  await page.goto(`${server.base}/#note/${noteA.id}`);
  await page.getByText(`${marker} 主记录 A`).waitFor();
  await chooseRelated(`${marker} 相关记录 B`);
  await page
    .locator(".handoff-panel fieldset")
    .nth(1)
    .getByText(`${marker} 相关记录的旧复盘`)
    .waitFor();
  assert.equal(
    await page
      .locator(".handoff-panel fieldset")
      .nth(2)
      .getByText(`${marker} 子记录但非反馈`)
      .count(),
    0,
  );
  await page
    .locator(".handoff-panel fieldset")
    .nth(1)
    .locator("label")
    .filter({ hasText: `${marker} 相关记录的旧复盘` })
    .locator('input[type="checkbox"]')
    .check();
  await page
    .locator(".handoff-panel fieldset")
    .nth(2)
    .locator("label")
    .filter({ hasText: `${marker} 相关记录的后续反馈` })
    .locator('input[type="checkbox"]')
    .check();
  const related = page
    .locator('.handoff-options input[type="checkbox"]')
    .first();

  // B03: changing related selection while a request is held cannot revive its old preview.
  let held = holdRpc("get_review_handoff");
  await page.route("**/api/rpc", held.handler);
  await page.getByRole("button", { name: "预览交接内容" }).click();
  await held.reached;
  await related.uncheck();
  assert.equal(
    await page
      .locator(".handoff-panel fieldset")
      .nth(1)
      .locator('input[type="checkbox"]:checked')
      .count(),
    0,
  );
  assert.equal(
    await page
      .locator(".handoff-panel fieldset")
      .nth(2)
      .locator('input[type="checkbox"]:checked')
      .count(),
    0,
  );
  held.release();
  await page.unroute("**/api/rpc", held.handler);
  await assertNoHandoff();

  // The same invalidation applies when source inclusion is cancelled.
  await related.check();
  const sources = page.getByRole("checkbox", { name: "附上可定位的来源原文" });
  await sources.check();
  held = holdRpc("get_review_handoff");
  await page.route("**/api/rpc", held.handler);
  await page.getByRole("button", { name: "预览交接内容" }).click();
  await held.reached;
  await sources.uncheck();
  held.release();
  await page.unroute("**/api/rpc", held.handler);
  await assertNoHandoff();

  // Navigation to another primary note invalidates the in-flight response.
  held = holdRpc("get_review_handoff");
  await page.route("**/api/rpc", held.handler);
  await page.getByRole("button", { name: "预览交接内容" }).click();
  await held.reached;
  await page.goto(`${server.base}/#note/${noteB.id}`);
  await page.getByText(`${marker} 相关记录 B`).first().waitFor();
  held.release();
  await page.unroute("**/api/rpc", held.handler);
  await assertNoHandoff();

  // B06: only explicitly checked previous review, feedback and sources enter the handoff.
  await page.goto(`${server.base}/#note/${noteA.id}`);
  await page.getByText(`${marker} 主记录 A`).waitFor();
  await chooseRelated(`${marker} 相关记录 B`);
  await page.getByRole("checkbox", { name: "附上可定位的来源原文" }).check();
  await page
    .locator(".handoff-panel fieldset")
    .nth(1)
    .locator('input[type="checkbox"]')
    .first()
    .check();
  await page
    .locator(".handoff-panel fieldset")
    .nth(1)
    .locator("label")
    .filter({ hasText: `${marker} 相关记录的旧复盘` })
    .locator('input[type="checkbox"]')
    .check();
  await page
    .locator(".handoff-panel fieldset")
    .nth(2)
    .locator('input[type="checkbox"]')
    .first()
    .check();
  await page
    .locator(".handoff-panel fieldset")
    .nth(2)
    .locator("label")
    .filter({ hasText: `${marker} 相关记录的后续反馈` })
    .locator('input[type="checkbox"]')
    .check();
  await page
    .getByRole("combobox", { name: "复盘意图" })
    .selectOption("heijin_review");
  const response = page.waitForResponse(
    (candidate) =>
      candidate.url().endsWith("/api/rpc") &&
      JSON.parse(candidate.request().postData() || "{}").tool ===
        "get_review_handoff",
  );
  await page.getByRole("button", { name: "预览交接内容" }).click();
  const result = (await (await response).json()).data;
  assert.deepEqual(result.selected.related_note_ids, [noteB.id]);
  assert.deepEqual(
    new Set(result.selected.review_ids),
    new Set([oldReview.id, relatedReview.id]),
  );
  assert.deepEqual(
    new Set(result.selected.feedback_note_ids),
    new Set([feedback.id, relatedFeedback.id]),
  );
  assert.equal(result.selected.include_sources, true);
  assert.equal(result.selected.method_intent, "heijin_review");
  assert.ok(
    result.source_summary.total_refs > 10,
    "fixture must create omitted source refs",
  );
  assert.ok(
    result.source_summary.truncated_refs.length > 0,
    `fixture must create truncated excerpt: ${JSON.stringify({ summary: result.source_summary, excerpt_lengths: result.source_excerpts.map((item) => item.text.length) })}`,
  );
  const handoff = page.locator(".handoff-preview");
  await handoff.waitFor();
  await page.screenshot({
    path: join(output, "handoff-preview.png"),
    fullPage: true,
  });
  const fullText = await handoff.innerText();
  for (const phrase of [
    `${marker} 主记录 A`,
    `${marker} 相关记录 B`,
    `${marker} 先前复盘正文`,
    `${marker} 后续反馈正文`,
    `${marker} 相关记录的旧复盘`,
    `${marker} 相关记录的后续反馈`,
    "发生时间：2026-09-23T16:10:00.000Z",
    "写入时间：",
    "固定引用：",
    "区段序号",
    "已截断来源：",
    "未附来源：",
    "工作台未提供完整的专门方法 Skill",
    "接收 Agent 是否具备对应 Skill",
  ])
    assert.ok(fullText.includes(phrase), `handoff missing ${phrase}`);
  assert.ok(!fullText.includes(`${marker} 未选记录 C`));
  await page.getByRole("button", { name: "复制交接内容" }).click();
  assert.equal(
    await page.evaluate(() => navigator.clipboard.readText()),
    fullText,
  );
  let downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载交接文件" }).click();
  let download = await downloadPromise;
  assert.equal(await readFile(await download.path(), "utf8"), fullText);

  // A changed selection requires a fresh preview; neither copy nor download can use A.
  await page
    .locator(".handoff-panel fieldset")
    .nth(2)
    .locator("label")
    .filter({ hasText: `${marker} 相关记录的后续反馈` })
    .locator('input[type="checkbox"]')
    .uncheck();
  await assertNoHandoff();
  await page.getByRole("button", { name: "预览交接内容" }).click();
  await handoff.waitFor();
  const reducedText = await handoff.innerText();
  assert.ok(!reducedText.includes(`${marker} 相关记录的后续反馈`));
  downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载交接文件" }).click();
  download = await downloadPromise;
  assert.equal(await readFile(await download.path(), "utf8"), reducedText);

  // B06: in-flight review A and changed selected links B have distinct persisted versions.
  const reviewInput = page.locator(
    'textarea[placeholder="粘贴外部复盘结果（Markdown 可用）"]',
  );
  await reviewInput.fill(`${marker} 新复盘`);
  const linkCheck = page.getByRole("checkbox", {
    name: /本次复盘同时回连交接中已选的/,
  });
  await linkCheck.check();
  const firstDraft = await page.evaluate(
    (id) => JSON.parse(localStorage.getItem(`workbench.review.${id}`)),
    noteA.id,
  );
  assert.deepEqual(firstDraft.linkedNoteIds, [noteB.id]);
  held = holdRpc(
    "save_review_result",
    (args) => args.body_md === `${marker} 新复盘`,
  );
  await page.route("**/api/rpc", held.handler);
  await page.getByRole("button", { name: "保存这次复盘" }).click();
  const submittedA = await held.reached;
  assert.deepEqual(submittedA.note_ids, [noteA.id, noteB.id]);
  await chooseRelated(`${marker} 未选记录 C`);
  await page
    .getByRole("textbox", { name: "查找相关记录" })
    .fill(`${marker} 相关记录 B`);
  await page
    .locator('.handoff-options input[type="checkbox"]')
    .first()
    .uncheck();
  const secondDraft = await page.evaluate(
    (id) => JSON.parse(localStorage.getItem(`workbench.review.${id}`)),
    noteA.id,
  );
  assert.deepEqual(secondDraft.linkedNoteIds, [noteC.id]);
  assert.notEqual(secondDraft.requestId, firstDraft.requestId);
  held.release();
  await page.unroute("**/api/rpc", held.handler);
  await page.getByText("上一版复盘已归档，新输入仍留在草稿中").waitFor();
  assert.deepEqual(
    await page.evaluate(
      (id) => JSON.parse(localStorage.getItem(`workbench.review.${id}`)),
      noteA.id,
    ),
    secondDraft,
  );
  const saveB = page.waitForRequest(
    (candidate) =>
      candidate.url().endsWith("/api/rpc") &&
      JSON.parse(candidate.postData() || "{}").tool === "save_review_result",
  );
  await page.getByRole("button", { name: "保存这次复盘" }).click();
  const submittedB = JSON.parse((await saveB).postData() || "{}").args;
  assert.deepEqual(submittedB.note_ids, [noteA.id, noteC.id]);
  assert.equal(submittedB.client_request_id, secondDraft.requestId);
  await page.getByText("外部复盘结果已归档，原始记录仍保留").waitFor();

  console.log("handoff-ui B03/B06/B09 passed on isolated demo server");
} catch (error) {
  failed = true;
  await page
    .screenshot({ path: join(output, "failure.png"), fullPage: true })
    .catch(() => {});
  console.error(error);
} finally {
  await context.tracing
    .stop({ path: join(output, failed ? "failure-trace.zip" : "trace.zip") })
    .catch(() => {});
  await browser.close();
  await server.stop();
}
if (failed) process.exitCode = 1;
