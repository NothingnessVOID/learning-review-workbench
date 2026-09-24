import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { chromium } from "@playwright/test";
import { startTestServer, session } from "./test-server.mjs";

const server = await startTestServer({ seed: false, fixture: "habit-fixture.ts" });
const fixture = JSON.parse(await readFile(join(server.dir, "habit-fixture.json"), "utf8"));
const artifactDir = process.env.HABIT_ARTIFACT_DIR || join(process.cwd(), "artifacts/habit-regression");
await mkdir(artifactDir, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}),
});

function databaseLearning(courseId) {
  const db = new DatabaseSync(join(server.dir, "workbench.sqlite"));
  try {
    db.exec("PRAGMA query_only=ON");
    const row = db.prepare("SELECT data FROM learning WHERE id=?").get(courseId);
    return row ? JSON.parse(row.data) : null;
  } finally {
    db.close();
  }
}

async function waitForLearning(courseId, predicate, description) {
  for (let i = 0; i < 50; i++) {
    const row = databaseLearning(courseId);
    if (predicate(row)) return row;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`SQLite did not persist ${description}; latest=${JSON.stringify(databaseLearning(courseId))}`);
}

let diagnosticPage = null;

async function screenshot(name, page) {
  await page.screenshot({ path: join(artifactDir, name), fullPage: true });
}

function defer() {
  let release;
  const promise = new Promise((resolve) => (release = resolve));
  return { promise, release };
}

try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: "Asia/Singapore" });
  const page = await context.newPage();

  // B01: follow an actual tb_* DOM anchor into SQLite, then restore in a fresh
  // browser context after deleting the localStorage bookmark.
  await page.goto(`${server.base}/#courses`);
  const courseRow = page.locator(".course-row").filter({ hasText: fixture.course_title });
  await courseRow.waitFor();
  await courseRow.click();
  await page.locator(".topic-link").filter({ hasText: "DEMO long topic" }).click();
  const renderedBlocks = page.locator(".teaching-block[data-teaching-block-id]");
  await renderedBlocks.first().waitFor();
  const anchorBlock = renderedBlocks.nth(Math.min(4, (await renderedBlocks.count()) - 1));
  const anchorId = await anchorBlock.getAttribute("data-teaching-block-id");
  assert.match(anchorId || "", /^tb_/);
  await page.waitForTimeout(180);
  await anchorBlock.evaluate((element) => {
    const y = window.scrollY + element.getBoundingClientRect().top - 100;
    window.scrollTo(0, Math.max(0, y));
  });
  await page.waitForTimeout(650);
  const saved = await waitForLearning(
    fixture.course_id,
    (row) => row?.position?.teaching_block_id === anchorId,
    "the rendered teaching block anchor",
  );
  assert.equal(saved.position.topic_id, fixture.long_topic_id);
  assert.ok(saved.position.scroll > 0);
  await page.evaluate((courseId) => localStorage.removeItem(`workbench.reader.${courseId}`), fixture.course_id);
  await context.close();

  const resumedContext = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: "Asia/Singapore" });
  const resumed = await resumedContext.newPage();
  diagnosticPage = resumed;
  await resumed.goto(`${server.base}/#courses`);
  await resumed.locator(".course-row").filter({ hasText: fixture.course_title }).click();
  await resumed.getByRole("button", { name: /继续阅读/ }).click();
  await resumed.waitForURL(new RegExp(`#topic/${fixture.long_topic_id}$`));
  await resumed.waitForFunction((id) => {
    const block = [...document.querySelectorAll("[data-teaching-block-id]")].find((node) => node.getAttribute("data-teaching-block-id") === id);
    return block && Math.abs(block.getBoundingClientRect().top - 135) < 35;
  }, anchorId);

  // Short topic: navigation away immediately after opening still stores its ID
  // and top position, so the last location does not remain the previous topic.
  await resumed.goto(`${server.base}/#course/${fixture.course_id}`);
  await resumed.locator(".topic-link").filter({ hasText: "DEMO short topic" }).click();
  await resumed.waitForURL(new RegExp(`#topic/${fixture.short_topic_id}$`));
  const shortBlock = resumed.locator(`[data-teaching-block-id="${fixture.short_block_id}"]`);
  await shortBlock.waitFor();
  await resumed.goto(`${server.base}/#course/${fixture.course_id}`);
  const shortSaved = await waitForLearning(
    fixture.course_id,
    (row) => row?.position?.topic_id === fixture.short_topic_id,
    "the short topic after immediate navigation",
  );
  assert.equal(shortSaved.position.scroll, 0);

  // B02: use the real date inputs in a Singapore browser context. Verify the
  // API receives a local half-open range and that the rendered timeline follows
  // occurred_at, falling back to created_at only when occurrence is unknown.
  const noteCalls = [];
  resumed.on("request", (request) => {
    if (request.url().endsWith("/api/rpc") && request.method() === "POST") {
      try {
        const body = request.postDataJSON();
        if (body.tool === "list_notes") noteCalls.push(body.args);
      } catch {}
    }
  });
  await resumed.goto(`${server.base}/#notes`);
  const dateFields = resumed.locator('input[type="date"]');
  await dateFields.nth(0).fill("2026-09-24");
  await dateFields.nth(1).fill("2026-09-24");
  await resumed.locator(".timeline-item").filter({ hasText: "DEMO browser date early" }).waitFor();
  await resumed.locator(".timeline-item").filter({ hasText: "DEMO browser date late" }).waitFor();
  assert.equal(await resumed.locator(".timeline-item").filter({ hasText: "DEMO browser date next" }).count(), 0);
  assert.equal(await resumed.locator(".timeline-item").filter({ hasText: "DEMO browser date previous" }).count(), 0);
  assert.equal(await resumed.locator(".timeline-item").filter({ hasText: "DEMO browser date backfilled outside selected day" }).count(), 0);
  const fallbackItem = resumed.locator(".timeline-item").filter({ hasText: "DEMO browser date created-time fallback" });
  await fallbackItem.waitFor();
  assert.match(await fallbackItem.locator(".timeline-date").innerText(), /^写入：/);
  const lastNoteCall = noteCalls.at(-1);
  assert.equal(lastNoteCall.from, "2026-09-23T16:00:00.000Z");
  assert.equal(lastNoteCall.to_exclusive, "2026-09-24T16:00:00.000Z");
  assert.equal("to" in lastNoteCall, false);
  await screenshot("b02-singapore-date-timeline.png", resumed);

  // B05: the note endpoint resolves the confirmed target, and following that
  // link opens the topic where the same note appears from the inverse side.
  await resumed.goto(`${server.base}/#note/${fixture.primary_note_id}`);
  await resumed.getByText("DEMO browser B05 linked note").waitFor();
  const linkedTopic = resumed.locator(".aside-link").filter({ hasText: "DEMO long topic" });
  await linkedTopic.waitFor();
  await linkedTopic.click();
  await resumed.waitForURL(new RegExp(`#topic/${fixture.long_topic_id}$`));
  await resumed.locator(".reading-aside").getByText("DEMO browser B05 link", { exact: false }).waitFor();
  const api = await session(server.base);
  const relationFiltered = await api.rpc("list_notes", { relation_id: fixture.long_topic_id, limit: 100 });
  assert.equal(relationFiltered.ok, true);
  assert.ok(relationFiltered.data.items.some((note) => note.id === fixture.primary_note_id));

  // B04: comparison must remain unavailable while its request is pending;
  // only the complete, revision-bound snapshot enables adoption.
  const gate = defer();
  const arrived = defer();
  await resumed.route("**/api/rpc", async (route) => {
    let body;
    try { body = route.request().postDataJSON(); } catch {}
    if (body?.tool === "get_draft_comparison" && body.args?.draft_id === fixture.draft_id) {
      const response = await route.fetch();
      arrived.release();
      await gate.promise;
      await route.fulfill({ response });
      return;
    }
    await route.continue();
  });
  await resumed.goto(`${server.base}/#draft/${fixture.draft_id}`);
  await arrived.promise;
  assert.equal(await resumed.getByRole("button", { name: "确认采用" }).count(), 0, "unready comparison must not offer adoption");
  assert.match(await resumed.locator("main").innerText(), /正在读取旧讲义全文与来源/);
  gate.release();
  await resumed.getByRole("button", { name: "确认采用" }).waitFor();
  const panes = resumed.locator(".diff-pane");
  assert.equal(await panes.count(), 2);
  assert.ok((await panes.nth(0).innerText()).includes(fixture.condition_text), "current pane must show the complete pre-change text");
  assert.ok(!(await panes.nth(1).innerText()).includes(fixture.condition_text), "proposed pane must expose the removed condition");
  assert.match(await resumed.locator(".change-summary").innerText(), /移除/);
  assert.ok((await resumed.locator(".change-summary").innerText()).includes(fixture.removed_block_id));
  await screenshot("b04-course-full-comparison.png", resumed);
  await resumed.unroute("**/api/rpc");

  // B07: assert the actual list response fields reach visible course/card DOM.
  await resumed.goto(`${server.base}/#courses`);
  const visibleCourse = resumed.locator(".course-row").filter({ hasText: fixture.course_title });
  await visibleCourse.getByText("已整理").waitFor();
  await resumed.goto(`${server.base}/#knowledge`);
  const visibleCard = resumed.locator(".knowledge-card").filter({ hasText: fixture.knowledge_title });
  await visibleCard.getByText("待核对").waitFor();

  console.log("Habit UI cross-layer passed: B01 SQLite bookmark/fresh-context restore/short topic, B02 Asia/Singapore date inputs, B04 gated full comparison, B05 confirmed inverse link, B07 status DOM.");
  await resumedContext.close();
} catch (error) {
  if (diagnosticPage) {
    await diagnosticPage.screenshot({ path: join(artifactDir, "habit-ui-failure.png"), fullPage: true }).catch(() => {});
  }
  throw error;
} finally {
  await browser.close();
  await server.stop();
}
