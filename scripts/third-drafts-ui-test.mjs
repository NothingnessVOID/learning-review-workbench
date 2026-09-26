import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { fingerprints, isCurrentBuild, readBuild } from "./build-info.mjs";
import { startTestServer, session, project } from "./test-server.mjs";

assert(isCurrentBuild(readBuild(project), fingerprints(project)),
  "Build dist/web from the current source before running this two-page UI test.");
const server = await startTestServer({ seed: false });
// Both tabs use the backend's actual same-origin UI and isolated temporary DB.
const appUrl = server.base;
const artifactDir = process.env.TEST_ARTIFACT_DIR ||
  fileURLToPath(new URL("../artifacts/third-review/drafts/", import.meta.url));
await mkdir(artifactDir, { recursive: true });
const open = async (page) => {
  await page.getByRole("button", { name: "记一句" }).click();
  await page.locator("#quick-text").waitFor();
};
const allDrafts = (page, base) => page.evaluate((key) =>
  Object.keys(localStorage)
    .filter((name) => name.startsWith(`${key}.entry.`))
    .map((name) => JSON.parse(localStorage.getItem(name)).draft), base);

let browser;
let context;
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}),
  });
  context = await browser.newContext();
  await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
  const a = await context.newPage();
  const b = await context.newPage();
  // Both tabs mount empty before either editor writes.
  await Promise.all([a.goto(appUrl + "/#courses"), b.goto(appUrl + "/#courses")]);
  await Promise.all([a.getByRole("button", { name: "记一句" }).waitFor(),
    b.getByRole("button", { name: "记一句" }).waitFor()]);
  await open(a);
  await a.locator("#quick-text").fill("SYNTHETIC draft A");
  await open(b);
  assert((await allDrafts(a, "workbench.quick-draft"))
    .some((draft) => draft.text === "SYNTHETIC draft A"));
  await b.locator("#quick-text").fill("SYNTHETIC draft B");
  assert.deepEqual(new Set((await allDrafts(a, "workbench.quick-draft"))
    .map((draft) => draft.text).filter(Boolean)),
    new Set(["SYNTHETIC draft A", "SYNTHETIC draft B"]));

  // A page opened from another page inherits sessionStorage in some browsers;
  // its editor identity must still be independent from B's.
  const copiedSessionStorage = await b.evaluate(() =>
    Object.fromEntries(
      Array.from({ length: sessionStorage.length }, (_, i) => {
        const key = sessionStorage.key(i);
        return [key, key ? sessionStorage.getItem(key) : null];
      }).filter(([key]) => key),
    ),
  );
  const copiedPage = await context.newPage();
  await copiedPage.addInitScript((values) => {
    for (const [key, value] of Object.entries(values))
      if (value !== null) sessionStorage.setItem(key, value);
  }, copiedSessionStorage);
  await copiedPage.goto(appUrl + "/#courses");
  await copiedPage.getByRole("button", { name: "记一句" }).waitFor();
  await copiedPage.getByRole("button", { name: "记一句" }).click();
  assert.notEqual(
    await copiedPage.evaluate(() => sessionStorage.getItem("workbench.editor.workbench.quick-draft")),
    await b.evaluate(() => sessionStorage.getItem("workbench.editor.workbench.quick-draft")),
  );
  assert((await allDrafts(copiedPage, "workbench.quick-draft"))
    .some((draft) => draft.text === "SYNTHETIC draft A"));
  await copiedPage.screenshot({ path: join(artifactDir, "quick-two-tab-recovery.png"), fullPage: true });
  await copiedPage.close();

  await a.getByRole("button", { name: "保存记录" }).click();
  await a.getByText("记录已保存").waitFor();
  assert((await allDrafts(b, "workbench.quick-draft"))
    .some((draft) => draft.text === "SYNTHETIC draft B"));
  await b.reload();
  await open(b);
  assert.equal(await b.locator("#quick-text").inputValue(), "SYNTHETIC draft B");
  await b.close();
  const reopened = await context.newPage();
  await reopened.goto(server.base + "/#courses");
  await open(reopened);
  await reopened.getByRole("button", { name: /恢复：SYNTHETIC draft B/ }).click();
  assert.equal(await reopened.locator("#quick-text").inputValue(), "SYNTHETIC draft B");
  await reopened.getByRole("button", { name: "关闭" }).click();

  // The same note has separate feedback and review slots per page.
  const api = await session(server.base);
  const listed = await api.rpc("list_notes", { limit: 30 });
  assert.equal(listed.ok, true);
  const note = listed.data.items.find((item) => item.original_text === "SYNTHETIC draft A");
  assert(note?.id);
  await Promise.all([a.goto(`${appUrl}/#note/${note.id}`),
    reopened.goto(`${appUrl}/#note/${note.id}`)]);
  await Promise.all([
    a.getByRole("heading", { name: "一条真实的记录" }).waitFor(),
    reopened.getByRole("heading", { name: "一条真实的记录" }).waitFor(),
  ]);
  await Promise.all([
    a.getByPlaceholder("后来……").waitFor(),
    reopened.getByPlaceholder("后来……").waitFor(),
  ]);
  await a.getByPlaceholder("后来……").fill("SYNTHETIC feedback A");
  await reopened.getByPlaceholder("后来……").fill("SYNTHETIC feedback B");
  await a.getByPlaceholder("粘贴外部复盘结果（Markdown 可用）").fill("SYNTHETIC review A");
  await reopened.getByPlaceholder("粘贴外部复盘结果（Markdown 可用）").fill("SYNTHETIC review B");
  assert.equal((await allDrafts(a, `workbench.feedback.${note.id}`))
    .filter((draft) => draft.text).length, 2);
  assert.equal((await allDrafts(a, `workbench.review.${note.id}`))
    .filter((draft) => draft.text).length, 2);
  await a.getByRole("button", { name: "保存后续反馈" }).click();
  await a.getByText("后续反馈已保存").waitFor();
  assert((await allDrafts(reopened, `workbench.feedback.${note.id}`))
    .some((draft) => draft.text === "SYNTHETIC feedback B"));
  await a.getByRole("button", { name: "保存这次复盘" }).click();
  await a.getByText("外部复盘结果已归档").waitFor();
  assert((await allDrafts(reopened, `workbench.review.${note.id}`))
    .some((draft) => draft.text === "SYNTHETIC review B"));

  // A fresh page can recover both same-note drafts left by the closed page.
  await reopened.close();
  const recoveredPage = await context.newPage();
  await recoveredPage.goto(`${appUrl}/#note/${note.id}`);
  await recoveredPage.getByRole("button", { name: /恢复 \d/ }).first().click();
  assert.equal(await recoveredPage.getByPlaceholder("后来……").inputValue(), "SYNTHETIC feedback B");
  await recoveredPage.route("**/api/rpc", async (route) => {
    const body = route.request().postDataJSON();
    if (body?.tool === "create_note" && body.args?.type === "feedback" &&
      body.args?.original_text === "SYNTHETIC feedback B") {
      await route.fulfill({ status: 500, contentType: "application/json",
        body: JSON.stringify({ ok: false, error: { message: "SYNTHETIC expected failure" } }) });
    } else await route.continue();
  });
  await recoveredPage.getByRole("button", { name: "保存后续反馈" }).click();
  await recoveredPage.getByText("SYNTHETIC expected failure").waitFor();
  assert.equal((await allDrafts(recoveredPage, `workbench.feedback.${note.id}`))
    .filter((draft) => draft.text === "SYNTHETIC feedback B").length, 2,
  "failed save must retain the recovered draft and its source");
  await recoveredPage.unroute("**/api/rpc");
  await recoveredPage.getByRole("button", { name: "保存后续反馈" }).click();
  await recoveredPage.getByText("后续反馈已保存").waitFor();
  assert(!(await allDrafts(recoveredPage, `workbench.feedback.${note.id}`))
    .some((draft) => draft.text === "SYNTHETIC feedback B"),
  "successful save must remove the recovered source so it is not offered again");
  await recoveredPage.getByRole("button", { name: /恢复 \d/ }).last().click();
  assert.equal(await recoveredPage.getByPlaceholder("粘贴外部复盘结果（Markdown 可用）").inputValue(), "SYNTHETIC review B");
  await recoveredPage.getByRole("button", { name: "保存这次复盘" }).click();
  await recoveredPage.getByText("外部复盘结果已归档").waitFor();
  assert(!(await allDrafts(recoveredPage, `workbench.review.${note.id}`))
    .some((draft) => draft.text === "SYNTHETIC review B"),
  "successful save must remove the recovered review source too");
  await recoveredPage.screenshot({ path: join(artifactDir, "same-note-feedback-review.png"), fullPage: true });

  // An old common-key draft survives migration and can be found after closing.
  const legacy = { text: "SYNTHETIC legacy draft", type: "quick", relationId: "",
    relationLabel: "", relationDismissed: false, requestId: crypto.randomUUID() };
  await recoveredPage.evaluate((value) => {
    localStorage.setItem("workbench.quick-draft", JSON.stringify(value));
    sessionStorage.removeItem("workbench.editor.workbench.quick-draft");
  }, legacy);
  const migrated = await context.newPage();
  await migrated.goto(server.base + "/#courses");
  await open(migrated);
  assert.equal(await migrated.locator("#quick-text").inputValue(), legacy.text);
  assert.equal(await migrated.evaluate(() => localStorage.getItem("workbench.quick-draft")), null);
  assert((await allDrafts(migrated, "workbench.quick-draft"))
    .some((draft) => draft.text === legacy.text));
  console.log(JSON.stringify({ ok: true, checks: [
    "two pages", "open without erase", "two edits", "save isolation", "reload",
    "close and recover", "feedback and review isolation", "legacy migration",
  ] }));
} finally {
  if (context) {
    await context.tracing.stop({ path: join(artifactDir, "third-drafts-trace.zip") }).catch(() => {});
    await context.close();
  }
  if (browser) await browser.close();
  await server.stop();
}
