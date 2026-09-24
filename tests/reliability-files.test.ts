import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import AdmZip from "adm-zip";
import {
  BackupManager,
  BACKUP_MAX_EXPANDED_BYTES,
} from "../src/domain/backup.js";
import { Store, sha, uid } from "../src/domain/store.js";
import {
  exportRuntimeContext,
  restoreRuntimeContext,
} from "../src/domain/context.js";
import {
  cancelImportPreview,
  completeImportPreview,
  importSource,
  pruneImportPreviews,
  sourcePreview,
} from "../src/domain/files.js";

async function withStore(
  run: (store: Store, dir: string) => Promise<void> | void,
) {
  const dir = mkdtempSync(join(tmpdir(), "learning-workbench-reliability-"));
  const store = new Store(dir);
  try {
    await run(store, dir);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
const markdown = (extra = "") =>
  `# DEMO 课程\n\n## 第一节\n\n第一段。\n\n第二段。${extra}\n`;
function addSource(store: Store, text = markdown()) {
  const bytes = Buffer.from(text);
  const result = importSource(
    store,
    {
      name: `DEMO_${uid("file")}.md`,
      sha256: sha(bytes),
      content_base64: bytes.toString("base64"),
    },
    { source_kind: "cleaned_transcript", series: "DEMO" },
  );
  return {
    ...result,
    path: join(store.dir, `sources/${sha(bytes)}.bin`),
    bytes,
  };
}

test("R03: backup restore accepts 999 and more than 1000 distinct source snapshots", async () => {
  for (const count of [999, 1001]) {
    await withStore(async (store, dir) => {
      const source = store.put(
        "sources",
        { id: uid("src"), original_name: "DEMO 多版本", source_kind: "other" },
        0,
      );
      for (let i = 0; i < count; i++) {
        const bytes = Buffer.from(`DEMO 源 ${i}`);
        const hash = sha(bytes),
          versionId = `sv_test_${i}`;
        writeFileSync(join(dir, "sources", `${hash}.bin`), bytes);
        store.put(
          "versions",
          {
            id: versionId,
            source_document_id: source.id,
            content_hash: hash,
            file_path: `sources/${hash}.bin`,
          },
          0,
        );
      }
      const manager = new BackupManager(store);
      const made = await manager.create();
      const archive = readFileSync(join(dir, "backups", `${made.id}.zip`));
      const freshDir = mkdtempSync(
        join(tmpdir(), "learning-workbench-restored-"),
      );
      const fresh = new Store(freshDir);
      try {
        const restore = new BackupManager(fresh);
        const preview = restore.previewRestore(archive.toString("base64"));
        assert.equal(preview.valid, true);
        const result = await restore.restore(preview.id);
        assert.equal(result.restored, true);
        assert.equal(fresh.all("versions").length, count);
        for (const version of fresh.all("versions"))
          assert.equal(
            sha(readFileSync(join(freshDir, version.file_path))),
            version.content_hash,
          );
      } finally {
        fresh.close();
        rmSync(freshDir, { recursive: true, force: true });
      }
    });
  }
});

test("R03: backup rejects data over 128 MiB before creating a downloadable archive", async () => {
  await withStore(async (store, dir) => {
    const source = store.put(
      "sources",
      { id: uid("src"), original_name: "DEMO 超大文件" },
      0,
    );
    const hash = sha("DEMO large"),
      path = join(dir, "sources", `${hash}.bin`);
    writeFileSync(path, "");
    truncateSync(path, BACKUP_MAX_EXPANDED_BYTES + 1); // Sparse local test file; no large allocation.
    store.put(
      "versions",
      {
        id: uid("sv"),
        source_document_id: source.id,
        content_hash: hash,
        file_path: `sources/${hash}.bin`,
      },
      0,
    );
    await assert.rejects(
      () => new BackupManager(store).create(),
      (error: any) => error.code === "PAYLOAD_TOO_LARGE",
    );
    assert.equal(
      readdirSync(join(dir, "backups")).some((name) => name.endsWith(".zip")),
      false,
    );
    assert.equal(readdirSync(join(dir, "staging")).length, 0);
  });
});

test("M04: opted-in backup restores fixed runtime context without credentials", async () => {
  await withStore(async (store, dir) => {
    const text = "DEMO 私有运行上下文，仅用于临时测试。";
    const snapshot = {
      schema_version: 1,
      sections: {
        user: {
          text,
          revision: 1,
          sha256: sha(text),
          origin: "demo-test",
          updated_at: new Date().toISOString(),
        },
      },
    };
    restoreRuntimeContext(dir, snapshot).commit();
    const made = await new BackupManager(store).create({
      include_context: true,
    });
    assert.equal(made.includes_runtime_context, true);
    const archive = readFileSync(join(dir, "backups", `${made.id}.zip`));
    const zip = new AdmZip(archive);
    assert(zip.getEntry("runtime-context.json"));
    assert.equal(zip.getEntry("credentials.json"), null);
    const freshDir = mkdtempSync(
      join(tmpdir(), "learning-workbench-context-restored-"),
    );
    const fresh = new Store(freshDir);
    try {
      const previousText = "DEMO 恢复前的另一份上下文。";
      restoreRuntimeContext(freshDir, {
        schema_version: 1,
        sections: {
          user: {
            text: previousText,
            revision: 4,
            sha256: sha(previousText),
            origin: "demo-before",
            updated_at: new Date().toISOString(),
          },
        },
      }).commit();
      const restore = new BackupManager(fresh);
      const preview = restore.previewRestore(archive.toString("base64"));
      await restore.restore(preview.id);
      assert.equal(exportRuntimeContext(freshDir)?.sections.user?.text, text);
      assert.notEqual(
        exportRuntimeContext(freshDir)?.sections.user?.text,
        previousText,
      );
    } finally {
      fresh.close();
      rmSync(freshDir, { recursive: true, force: true });
    }
  });
});

for (const damage of ["missing", "corrupt"] as const) {
  test(`R04: valid backup restores ${damage} current source and marks rescue copy`, async () => {
    await withStore(async (store, dir) => {
      const original = addSource(store);
      const manager = new BackupManager(store);
      const made = await manager.create();
      const archive = readFileSync(join(dir, "backups", `${made.id}.zip`));
      if (damage === "missing") rmSync(original.path);
      else writeFileSync(original.path, randomBytes(32));
      const preview = manager.previewRestore(archive.toString("base64"));
      const restored = await manager.restore(preview.id);
      assert.equal(restored.restored, true);
      assert.equal(restored.previous_backup_kind, "damaged_rescue");
      assert.deepEqual(readFileSync(original.path), original.bytes);
      const rescue = JSON.parse(
        readFileSync(join(restored.rescue_path, "manifest.json"), "utf8"),
      );
      assert.equal(rescue.complete, false);
      assert(
        rescue.issues.some(
          (issue: any) =>
            issue.problem ===
            (damage === "missing" ? "missing" : "hash_mismatch"),
        ),
      );
      assert.equal(store.all("blocks").length > 0, true);
    });
  });
}

test("R04: oversized damaged current source still permits validated restore with rescue", async () => {
  await withStore(async (store, dir) => {
    const source = addSource(store);
    const manager = new BackupManager(store);
    const made = await manager.create();
    const archive = readFileSync(join(dir, "backups", `${made.id}.zip`));
    truncateSync(source.path, BACKUP_MAX_EXPANDED_BYTES + 1);
    const preview = manager.previewRestore(archive.toString("base64"));
    const result = await manager.restore(preview.id);
    assert.equal(result.previous_backup_kind, "damaged_rescue");
    assert.deepEqual(readFileSync(source.path), source.bytes);
    const rescue = JSON.parse(
      readFileSync(join(result.rescue_path, "manifest.json"), "utf8"),
    );
    assert.equal(rescue.complete, false);
    assert(
      rescue.issues.some(
        (issue: any) => issue.problem === "normal_backup_capacity_exceeded",
      ),
    );
    assert(
      rescue.issues.some((issue: any) => issue.problem === "hash_mismatch"),
    );
  });
});

test("R04: changed staged ZIP bytes are rejected before replacing current data", async () => {
  await withStore(async (store, dir) => {
    const source = addSource(store);
    const manager = new BackupManager(store);
    const made = await manager.create();
    const archive = readFileSync(join(dir, "backups", `${made.id}.zip`));
    const preview = manager.previewRestore(archive.toString("base64"));
    const staged = store.setting(`restore:${preview.id}`);
    writeFileSync(
      join(staged.dir, `sources/${sha(source.bytes)}.bin`),
      "tampered",
    );
    await assert.rejects(
      () => manager.restore(preview.id),
      (error: any) => error.code === "VALIDATION_ERROR",
    );
    assert.deepEqual(readFileSync(source.path), source.bytes);
    assert.equal(store.all("versions").length, 1);
  });
});

test("R04/M04: failed restore rolls back source, database, and previous runtime context", async () => {
  await withStore(async (store, dir) => {
    const source = addSource(store);
    const beforeText = "DEMO 恢复前上下文";
    const afterText = "DEMO 备份内上下文";
    const context = (text: string) => ({
      schema_version: 1 as const,
      sections: {
        user: {
          text,
          revision: 1,
          sha256: sha(text),
          origin: "demo",
          updated_at: new Date().toISOString(),
        },
      },
    });
    restoreRuntimeContext(dir, context(afterText)).commit();
    const manager = new BackupManager(store);
    const made = await manager.create({ include_context: true });
    const archive = readFileSync(join(dir, "backups", `${made.id}.zip`));
    writeFileSync(source.path, "DEMO 恢复前的损坏原文");
    const currentSource = readFileSync(source.path);
    restoreRuntimeContext(dir, context(beforeText)).commit();
    const preview = manager.previewRestore(archive.toString("base64"));
    const originalAudit = store.audit.bind(store);
    (store as any).audit = () => {
      throw new Error("injected restore failure");
    };
    try {
      await assert.rejects(
        () => manager.restore(preview.id),
        /injected restore failure/,
      );
    } finally {
      (store as any).audit = originalAudit;
    }
    assert.deepEqual(readFileSync(source.path), currentSource);
    assert.equal(exportRuntimeContext(dir)?.sections.user?.text, beforeText);
    assert.equal(store.all("versions").length, 1);
    assert.equal(
      store.setting(`restore:${preview.id}`)?.dir,
      join(dir, "staging", preview.id),
    );
  });
});

test("R06: preview stores bytes outside SQLite, cancel/commit/expiry clean staging", async () => {
  await withStore((store, dir) => {
    const upload = {
      name: "DEMO.md",
      content_base64: Buffer.from(markdown()).toString("base64"),
    };
    const first = sourcePreview(store, [upload], {
      source_kind: "cleaned_transcript",
      series: "DEMO",
      files: [upload],
    });
    const row = JSON.parse(
      store.db
        .prepare("SELECT data FROM import_previews WHERE id=?")
        .get(first.id)!.data as string,
    );
    assert.equal(JSON.stringify(row).includes("content_base64"), false);
    assert.equal(Object.hasOwn(row.options, "files"), false);
    assert.equal(readdirSync(join(dir, "staging", first.id)).length, 1);
    cancelImportPreview(store, first.id);
    assert.equal(readdirSync(join(dir, "staging")).includes(first.id), false);

    const second = sourcePreview(store, [upload], {});
    const value = JSON.parse(
      store.db
        .prepare("SELECT data FROM import_previews WHERE id=?")
        .get(second.id)!.data as string,
    );
    value.committed = { imported: [{ id: "demo" }], skipped: [] };
    store.db
      .prepare("UPDATE import_previews SET data=? WHERE id=?")
      .run(JSON.stringify(value), second.id);
    assert.equal(completeImportPreview(store, second.id), true);
    const compact = JSON.parse(
      store.db
        .prepare("SELECT data FROM import_previews WHERE id=?")
        .get(second.id)!.data as string,
    );
    assert.deepEqual(compact.entries, []);
    assert.equal(readdirSync(join(dir, "staging")).includes(second.id), false);

    const third = sourcePreview(store, [upload], {});
    const old = JSON.parse(
      store.db
        .prepare("SELECT data FROM import_previews WHERE id=?")
        .get(third.id)!.data as string,
    );
    old.created_at = "2000-01-01T00:00:00.000Z";
    store.db
      .prepare("UPDATE import_previews SET data=? WHERE id=?")
      .run(JSON.stringify(old), third.id);
    pruneImportPreviews(store);
    const expired = JSON.parse(
      store.db
        .prepare("SELECT data FROM import_previews WHERE id=?")
        .get(third.id)!.data as string,
    );
    assert.equal(expired.status, "expired");
    assert.deepEqual(expired.entries, []);
    assert.equal(readdirSync(join(dir, "staging")).includes(third.id), false);
    const broken = sourcePreview(
      store,
      [
        {
          name: "broken.json",
          content_base64: Buffer.from("{bad JSON").toString("base64"),
        },
      ],
      {},
    );
    assert.equal(broken.items[0].status, "error");
    assert.equal(readdirSync(join(dir, "staging")).includes(broken.id), false);
  });
});

test("R06: expired staged uploads are cleaned after a store restart", () => {
  const dir = mkdtempSync(
    join(tmpdir(), "learning-workbench-preview-restart-"),
  );
  let store = new Store(dir);
  try {
    const upload = {
      name: "DEMO.md",
      content_base64: Buffer.from(markdown()).toString("base64"),
    };
    const preview = sourcePreview(store, [upload], {});
    const value = JSON.parse(
      store.db
        .prepare("SELECT data FROM import_previews WHERE id=?")
        .get(preview.id)!.data as string,
    );
    value.created_at = "2000-01-01T00:00:00.000Z";
    store.db
      .prepare("UPDATE import_previews SET data=? WHERE id=?")
      .run(JSON.stringify(value), preview.id);
    store.close();
    store = new Store(dir);
    pruneImportPreviews(store);
    assert.equal(readdirSync(join(dir, "staging")).includes(preview.id), false);
    const expired = JSON.parse(
      store.db
        .prepare("SELECT data FROM import_previews WHERE id=?")
        .get(preview.id)!.data as string,
    );
    assert.equal(expired.status, "expired");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R07: share redaction preserves JSON keys and IDs while preview matches ZIP", async () => {
  await withStore((store, dir) => {
    const id = "note_notes_1";
    store.put(
      "notes",
      {
        id,
        original_text: '张三说 "notes" 和 \\ 路径。',
        type: "quick",
        relation_ids: [],
      },
      0,
    );
    const terms = ["张三", '"', "\\", "notes"];
    const result = new BackupManager(store).exportData({
      scope: "notes",
      ids: [id],
      share: true,
      redactions: terms,
    });
    const parsed = JSON.parse(result.preview);
    assert.equal(parsed.notes[0].id, id);
    assert.equal(Object.hasOwn(parsed, "notes"), true);
    assert.equal(parsed.notes[0].original_text.includes("张三"), false);
    assert.equal(parsed.notes[0].original_text.includes("notes"), false);
    assert.equal(parsed.notes[0].original_text.includes("\\"), false);
    assert.deepEqual(result.parameters, {
      scope: "notes",
      ids: [id],
      share: true,
      redactions: terms,
    });
    const zip = new AdmZip(join(dir, "exports", `${result.id}.zip`));
    assert.equal(
      zip.getEntry("data.json")!.getData().toString(),
      result.preview,
    );
    assert.equal(
      zip.getEntry(`notes/${id}.md`)!.getData().toString().includes("张三"),
      false,
    );
  });
});

test("U02: headings group multiple source blocks into one unreviewed topic", async () => {
  await withStore((store) => {
    const text = `# DEMO 课程\n\n## 一节\n\n${Array.from({ length: 10 }, (_, i) => `原文第 ${i + 1} 段。`).join("\n\n")}\n\n## 二节\n\n末段。`;
    const added = addSource(store, text);
    const blocks = store
      .all("blocks")
      .filter((block) => block.source_version_id === added.source_version_id);
    const topics = store
      .all("topics")
      .filter((topic) => topic.course_id === added.course_id);
    assert(topics.length < blocks.length);
    assert.equal(topics.filter((topic) => topic.title === "一节").length, 1);
    const referenced = topics.flatMap((topic) =>
      topic.blocks.flatMap((block: any) =>
        block.source_refs.map((ref: any) => ref.source_block_id),
      ),
    );
    assert.deepEqual(
      new Set(referenced),
      new Set(blocks.map((block) => block.id)),
    );
    assert(topics.every((topic) => topic.content_kind === "source_text"));
  });
});
