import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Service } from "../src/domain/service.js";
import { sha } from "../src/domain/store.js";

function upload(name: string, text: string) {
  return { name, content_base64: Buffer.from(text).toString("base64") };
}

async function withService(
  run: (service: Service, dir: string) => Promise<void>,
) {
  const dir = mkdtempSync(join(tmpdir(), "learning-workbench-import-failure-"));
  const service = new Service(dir, dir);
  try {
    await run(service, dir);
  } finally {
    service.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("R06: failed commit rolls back DB and staging, removes only newly written unreferenced source", async () => {
  await withService(async (service, dir) => {
    const existing = "# DEMO 既存孤儿原文\n\n保留这份原文。";
    const novel = "# DEMO 新原文\n\n事务失败后不应留下它。";
    const existingPath = join(dir, "sources", `${sha(existing)}.bin`);
    const novelPath = join(dir, "sources", `${sha(novel)}.bin`);
    writeFileSync(existingPath, existing);
    const files = [
      upload("existing.md", existing),
      upload("novel.md", novel),
      upload(
        "invalid-course.json",
        JSON.stringify({ topics: [], source_version_ids: [] }),
      ),
    ];
    const preview = await service.invoke("preview_import", {
      files,
      source_kind: "other",
    });
    assert.equal(preview.ok, true);
    const previewId = preview.data.id as string;
    assert.equal(existsSync(join(dir, "staging", previewId)), true);

    const result = await service.invoke("commit_import", {
      preview_id: previewId,
    });
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "VALIDATION_ERROR");
    assert.equal(service.store.all("versions").length, 0);
    assert.equal(service.store.all("sources").length, 0);
    assert.equal(existsSync(join(dir, "staging", previewId)), false);
    assert.equal(
      service.store.db
        .prepare("SELECT count(*) AS n FROM import_previews WHERE id=?")
        .get(previewId)!.n,
      0,
    );
    assert.equal(existsSync(novelPath), false);
    assert.equal(readFileSync(existingPath, "utf8"), existing);
  });
});

test("R06: successful commit remains idempotent after staging cleanup", async () => {
  await withService(async (service, dir) => {
    const text = "# DEMO 成功来源\n\n第一次提交保存。";
    const preview = await service.invoke("preview_import", {
      files: [upload("success.md", text)],
      source_kind: "other",
    });
    assert.equal(preview.ok, true);
    const previewId = preview.data.id as string;
    const first = await service.invoke("commit_import", {
      preview_id: previewId,
    });
    assert.equal(first.ok, true);
    assert.equal(existsSync(join(dir, "staging", previewId)), false);
    const second = await service.invoke("commit_import", {
      preview_id: previewId,
    });
    assert.equal(second.ok, true);
    assert.deepEqual(second.data, first.data);
    assert.equal(service.store.all("versions").length, 1);
  });
});
