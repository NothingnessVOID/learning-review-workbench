// C03/C04/C05 isolated browser regression. Requires a built project (TEST_PROJECT_ROOT may point to QA copy).
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { project, session, startTestServer } from "./test-server.mjs";

const output = join(project, "artifacts", "third-review", "note");
await mkdir(output, { recursive: true });
const server = await startTestServer({ seed: false });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
    ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
    : {}),
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const marker = `THIRD-NOTE-${Date.now()}`;
async function rpc(client, tool, args) {
  const response = await client.rpc(tool, args);
  assert.equal(response.ok, true, `${tool}: ${JSON.stringify(response.error)}`);
  return response.data;
}
async function selectFile(name, text) {
  await page
    .locator('input[type="file"][accept*="markdown"]')
    .setInputFiles({
      name,
      mimeType: "text/markdown",
      buffer: Buffer.from(text),
    });
}
async function releaseFile(name, value, fail = false) {
  await page.evaluate(
    ({ name, value, fail }) => {
      const pending = window.__reviewFilePending.get(name);
      assertPending(pending);
      window.__reviewFilePending.delete(name);
      if (fail) pending.reject(new Error(value));
      else pending.resolve(value);
      function assertPending(item) {
        if (!item) throw Error(`missing delayed file ${name}`);
      }
    },
    { name, value, fail },
  );
}
async function waitFile(name) {
  await page.waitForFunction(
    (name) => !!window.__reviewFilePending?.get(name),
    name,
  );
}
try {
  const client = await session(server.base);
  const note = await rpc(client, "create_note", {
    original_text: `${marker} 主记录`,
    type: "event",
    client_request_id: crypto.randomUUID(),
  });
  const reviewInput = page.locator('textarea[placeholder^="粘贴外部复盘"]');
  await page.addInitScript(() => {
    window.__reviewFilePending = new Map();
    File.prototype.text = function () {
      return new Promise((resolve, reject) =>
        window.__reviewFilePending.set(this.name, { resolve, reject }),
      );
    };
  });
  await page.goto(`${server.base}/#note/${note.id}`);
  await reviewInput.waitFor();

  await selectFile("A.md", "A");
  await waitFile("A.md");
  await reviewInput.fill(`${marker} 后写 B`);
  await releaseFile("A.md", "A");
  await page.getByRole("button", { name: "追加文件内容" }).waitFor();
  assert.equal(await reviewInput.inputValue(), `${marker} 后写 B`);
  await page.getByRole("button", { name: "忽略文件内容" }).click();

  await selectFile("first.md", "first");
  await waitFile("first.md");
  await selectFile("second.md", "second");
  await waitFile("second.md");
  await releaseFile("second.md", "SECOND");
  await assertEventuallyValue(page, "SECOND", reviewInput);
  await releaseFile("first.md", "FIRST");
  assert.equal(await reviewInput.inputValue(), "SECOND");

  await selectFile("broken.md", "broken");
  await waitFile("broken.md");
  await releaseFile("broken.md", "synthetic read failure", true);
  await page.getByText(/文件读取失败.*synthetic read failure/).waitFor();
  assert.equal(await reviewInput.inputValue(), "SECOND");

  await selectFile("navigation.md", "navigation");
  await waitFile("navigation.md");
  await page.evaluate(() => {
    location.hash = "notes";
  });
  await reviewInput.waitFor({ state: "detached" });
  await releaseFile("navigation.md", "SHOULD_NOT_APPEAR");
  await page.evaluate((id) => {
    location.hash = `note/${id}`;
  }, note.id);
  await reviewInput.waitFor();
  await assertEventuallyValue(page, "SECOND", reviewInput);
  await page.reload();
  await reviewInput.waitFor();
  await assertEventuallyValue(page, "SECOND", reviewInput);

  await selectFile("fresh.md", "fresh");
  await waitFile("fresh.md");
  await releaseFile("fresh.md", "FRESH");
  await assertEventuallyValue(page, "FRESH", reviewInput);

  const oldReview = await rpc(client, "save_review_result", {
    note_ids: [note.id],
    body_md: `${marker} 旧复盘正文`,
    gaps: ["独立待核项"],
    basis: ["旧文字依据"],
    client_request_id: crypto.randomUUID(),
  });
  const followup = await rpc(client, "create_note", {
    original_text: `${marker} 补记旧事`,
    type: "feedback",
    parent_note_id: note.id,
    occurred_at: "2020-01-02T00:00:00Z",
    client_request_id: crypto.randomUUID(),
  });
  await page.reload();
  await page.locator(".timeline-panel").first().waitFor();
  const timeline = await page.locator(".timeline-panel").allTextContents();
  assert.match(timeline[0], /补记旧事/);
  assert.match(timeline[0], /发生于/);
  assert.match(timeline[1], /旧复盘正文/);
  assert.match(timeline[1], /写入于/);
  await page
    .locator(".handoff-panel fieldset")
    .filter({ hasText: "先前复盘" })
    .locator('input[type="checkbox"]')
    .first()
    .check();
  await page.getByRole("button", { name: "预览交接内容" }).click();
  const handoff = page.locator(".handoff-preview");
  await handoff.waitFor();
  const text = await handoff.innerText();
  for (const part of [
    oldReview.id,
    "独立待核项",
    "旧文字依据",
    `/#note/${note.id}`,
  ])
    assert.ok(text.includes(part), part);
  await page.screenshot({
    path: join(output, "mixed-timeline-handoff.png"),
    fullPage: true,
  });
  console.log(
    JSON.stringify({
      ok: true,
      note: note.id,
      review: oldReview.id,
      followup: followup.id,
      cases: [
        "A-delayed",
        "A-B-order",
        "read-failure",
        "navigation-and-reload",
        "fresh-file-load",
        "timeline",
        "handoff",
      ],
    }),
  );
} finally {
  await browser.close();
  await server.stop();
}

async function assertEventuallyValue(page, expected, locator) {
  await page.waitForFunction(
    ({ selector, expected }) =>
      document.querySelector(selector)?.value === expected,
    { selector: 'textarea[placeholder^="粘贴外部复盘"]', expected },
  );
}
