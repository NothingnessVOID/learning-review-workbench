import { DatabaseSync, backup } from "node:sqlite";
import AdmZip from "adm-zip";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  copyFileSync,
  rmSync,
  chmodSync,
} from "node:fs";
import { join } from "node:path";
import {
  Store,
  uid,
  sha,
  now,
  tables,
  type Obj,
  defaultPermissions,
} from "./store.js";
import { check, parse, id as idSchema } from "./schema.js";
import { unzipSafe, safeName } from "./files.js";
export class BackupManager {
  constructor(public store: Store) {}
  async create() {
    const s = this.store;
    const id = uid("backup");
    const stage = join(s.dir, "staging", id);
    mkdirSync(stage, { recursive: true, mode: 0o700 });
    const dbFile = join(stage, "workbench.sqlite");
    await backup(s.db, dbFile);
    chmodSync(dbFile, 0o600);
    const snapshot = new DatabaseSync(dbFile, { readOnly: true });
    let counts: Obj;
    let versions: Obj[];
    try {
      counts = Object.fromEntries(
        tables.map((t) => [
          t,
          Number(snapshot.prepare(`SELECT count(*) n FROM ${t}`).get()!.n),
        ]),
      );
      versions = snapshot
        .prepare("SELECT data FROM versions")
        .all()
        .map((r) => JSON.parse(r.data as string));
    } finally {
      snapshot.close();
    }
    const zip = new AdmZip();
    const files: Obj[] = [];
    const add = (name: string, b: Buffer) => {
      zip.addFile(name, b);
      files.push({ path: name, sha256: sha(b), size: b.length });
    };
    add("workbench.sqlite", readFileSync(dbFile));
    for (const path of new Set(versions.map((v) => v.file_path))) {
      safeName(path);
      const full = join(s.dir, path);
      check(existsSync(full), "NOT_FOUND", "备份失败：来源文件缺失。", {
        path,
      });
      add(path, readFileSync(full));
    }
    zip.addFile(
      "manifest.json",
      Buffer.from(
        JSON.stringify(
          {
            schema_version: "1.0.0",
            kind: "learning_workbench_backup",
            created_at: now(),
            counts,
            files,
          },
          null,
          2,
        ),
      ),
    );
    const filename = `学习工作台备份_${new Date().toISOString().replaceAll(":", "-")}.zip`;
    const file = join(s.dir, "backups", id + ".zip");
    writeFileSync(file, zip.toBuffer(), { mode: 0o600 });
    s.setting(`download:${id}`, { file, filename });
    rmSync(stage, { recursive: true, force: true });
    return { id, filename, download_url: `/api/download/${id}`, counts };
  }
  previewRestore(content: string) {
    check(
      typeof content === "string" && content.length < 190 * 1024 * 1024,
      "PAYLOAD_TOO_LARGE",
      "备份体积超过上限。",
    );
    const files = unzipSafe(Buffer.from(content, "base64"), 128 * 1024 * 1024);
    const mf = files.find((f) => f.name === "manifest.json");
    check(mf, "VALIDATION_ERROR", "缺少备份清单。");
    let manifest: Obj;
    try {
      manifest = JSON.parse(mf.buffer.toString("utf8"));
    } catch {
      throw new Error("Invalid manifest");
    }
    check(
      manifest.kind === "learning_workbench_backup" &&
        manifest.schema_version === "1.0.0",
      "VALIDATION_ERROR",
      "备份格式或 schema 版本不兼容。",
    );
    check(
      Array.isArray(manifest.files) &&
        manifest.files.length === files.length - 1,
      "VALIDATION_ERROR",
      "备份清单与文件数量不一致。",
    );
    const id = uid("restore");
    const dir = join(this.store.dir, "staging", id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      const names = new Set<string>();
      for (const f of manifest.files) {
        check(
          typeof f.path === "string" && !names.has(f.path),
          "VALIDATION_ERROR",
          "清单路径重复或无效。",
        );
        names.add(f.path);
        check(
          f.path === "workbench.sqlite" ||
            /^sources\/[a-f0-9]{64}\.bin$/.test(f.path),
          "VALIDATION_ERROR",
          "备份含有非数据文件。",
        );
        const entry = files.find((e) => e.name === f.path);
        check(
          entry &&
            sha(entry.buffer) === f.sha256 &&
            entry.buffer.length === f.size,
          "VALIDATION_ERROR",
          "备份文件哈希校验失败。",
          { file: f.path },
        );
        if (f.path.startsWith("sources/"))
          mkdirSync(join(dir, "sources"), { recursive: true });
        writeFileSync(join(dir, f.path), entry.buffer, { mode: 0o600 });
      }
      check(names.has("workbench.sqlite"), "VALIDATION_ERROR", "缺少数据库。");
      const candidate = new DatabaseSync(join(dir, "workbench.sqlite"), {
        readOnly: true,
      });
      try {
        candidate.exec("PRAGMA trusted_schema=OFF");
        check(
          candidate.prepare("PRAGMA integrity_check").get()!.integrity_check ===
            "ok",
          "VALIDATION_ERROR",
          "数据库完整性检查失败。",
        );
        check(
          Number(
            candidate.prepare("PRAGMA user_version").get()!.user_version,
          ) === 1,
          "VALIDATION_ERROR",
          "数据库版本不兼容。",
        );
        const schema = (db: DatabaseSync) =>
          db
            .prepare(
              "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
            )
            .all();
        check(
          JSON.stringify(schema(candidate)) ===
            JSON.stringify(schema(this.store.db)),
          "VALIDATION_ERROR",
          "数据库结构不匹配，禁止未知触发器或表。",
        );
        const counts = Object.fromEntries(
          tables.map((t) => [
            t,
            Number(candidate.prepare(`SELECT count(*) n FROM ${t}`).get()!.n),
          ]),
        );
        check(
          JSON.stringify(counts) === JSON.stringify(manifest.counts),
          "VALIDATION_ERROR",
          "备份记录数量不一致。",
        );
        const get = (t: string, i: string) => {
          const r = candidate
            .prepare(`SELECT data FROM ${t} WHERE id=?`)
            .get(i);
          return r ? JSON.parse(r.data as string) : null;
        };
        for (const r of candidate.prepare("SELECT data FROM versions").all()) {
          const v = JSON.parse(r.data as string);
          check(
            /^sources\/[a-f0-9]{64}\.bin$/.test(v.file_path) &&
              names.has(v.file_path) &&
              get("sources", v.source_document_id),
            "SOURCE_REF_INVALID",
            "备份中来源关系或快照缺失。",
          );
          check(
            sha(readFileSync(join(dir, v.file_path))) === v.content_hash,
            "SOURCE_REF_INVALID",
            "来源快照与版本哈希不一致。",
          );
        }
        for (const r of candidate.prepare("SELECT data FROM blocks").all()) {
          const b = JSON.parse(r.data as string),
            v = get("versions", b.source_version_id);
          check(
            v && v.source_document_id === b.source_document_id,
            "SOURCE_REF_INVALID",
            "备份原文区段关系无效。",
          );
        }
        for (const t of ["courses", "topics", "cards", "reviews", "notes"])
          for (const r of candidate.prepare(`SELECT data FROM ${t}`).all()) {
            const v = JSON.parse(r.data as string);
            if (t === "courses")
              for (const version of v.source_version_ids)
                check(
                  get("versions", version),
                  "SOURCE_REF_INVALID",
                  "课程来源版本缺失。",
                );
            if (t === "topics")
              check(
                get("courses", v.course_id),
                "SOURCE_REF_INVALID",
                "主题课程缺失。",
              );
            if (t === "reviews")
              for (const n of v.note_ids)
                check(
                  get("notes", n),
                  "SOURCE_REF_INVALID",
                  "复盘原始记录缺失。",
                );
            for (const ref of [
              ...(v.source_refs ?? []),
              ...(v.blocks ?? []).flatMap((b: Obj) => b.source_refs ?? []),
            ]) {
              const b = get("blocks", ref.source_block_id);
              check(
                b &&
                  b.source_version_id === ref.source_version_id &&
                  b.source_document_id === ref.source_document_id,
                "SOURCE_REF_INVALID",
                "备份引用校验失败。",
              );
            }
          }
        this.store.setting(`restore:${id}`, { dir, manifest });
        return {
          id,
          counts,
          valid: true,
          warnings: [
            "恢复会替换当前数据；恢复前自动备份现状，MCP 个人记录授权将清空。",
          ],
        };
      } finally {
        candidate.close();
      }
    } catch (e) {
      rmSync(dir, { recursive: true, force: true });
      throw e;
    }
  }
  async restore(id: string) {
    const info = this.store.setting(`restore:${id}`);
    check(info, "NOT_FOUND", "恢复预览不存在，请重新上传。");
    const prior = await this.create();
    const s = this.store;
    const original = join(s.dir, "backups", uid("before_restore") + ".sqlite");
    s.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    s.close();
    try {
      copyFileSync(s.dbPath, original);
      for (const f of info.manifest.files) {
        if (f.path.startsWith("sources/")) {
          const dest = join(s.dir, f.path);
          if (!existsSync(dest)) copyFileSync(join(info.dir, f.path), dest);
        }
      }
      const next = s.dbPath + ".restore";
      copyFileSync(join(info.dir, "workbench.sqlite"), next);
      rmSync(s.dbPath + "-wal", { force: true });
      rmSync(s.dbPath + "-shm", { force: true });
      renameSync(next, s.dbPath);
      s.reopen();
      s.db
        .prepare("DELETE FROM settings WHERE key LIKE ? OR key LIKE ?")
        .run("download:%", "restore:%");
      s.setting("permissions", defaultPermissions);
      s.audit("local_user", "restore_backup");
      rmSync(info.dir, { recursive: true, force: true });
      return { restored: true, previous_backup: prior.filename };
    } catch (e) {
      try {
        s.close();
      } catch {}
      if (existsSync(original)) {
        copyFileSync(original, s.dbPath);
        rmSync(s.dbPath + "-wal", { force: true });
        rmSync(s.dbPath + "-shm", { force: true });
      }
      s.reopen();
      throw e;
    }
  }
  exportData(a: Obj) {
    check(
      ["all", "course", "knowledge", "notes"].includes(a.scope),
      "VALIDATION_ERROR",
      "请选择有效导出范围。",
    );
    const ids = a.ids ?? [];
    check(
      Array.isArray(ids) && ids.length <= 10000,
      "VALIDATION_ERROR",
      "导出 ID 格式错误。",
    );
    for (const i of ids) parse(idSchema, i);
    check(
      a.scope === "all" || ids.length,
      "VALIDATION_ERROR",
      "请先选中要导出的对象。",
    );
    const s = this.store,
      data: Obj = {
        schema_version: "1.0.0",
        kind: "learning_workbench_export",
        exported_at: now(),
        scope: a.scope,
      };
    let courses: Obj[] = [],
      cards: Obj[] = [],
      notes: Obj[] = [];
    if (a.scope === "all") {
      for (const t of tables) data[t] = s.all(t, true);
    } else {
      if (a.scope === "course") courses = ids.map((i) => s.get("courses", i)!);
      if (a.scope === "knowledge") cards = ids.map((i) => s.get("cards", i)!);
      if (a.scope === "notes") notes = ids.map((i) => s.get("notes", i)!);
      const topics = s
        .all("topics", true)
        .filter(
          (t) =>
            courses.some((c) => c.id === t.course_id) ||
            cards.some((c) => c.topic_ids.includes(t.id)),
        );
      if (courses.length)
        cards = s
          .all("cards")
          .filter((c) =>
            c.topic_ids.some((i: string) => topics.some((t) => t.id === i)),
          );
      const versionIds = new Set([
        ...courses.flatMap((c) => c.source_version_ids),
        ...cards.flatMap((c) =>
          c.source_refs.map((r: Obj) => r.source_version_id),
        ),
        ...topics.flatMap((t) =>
          t.blocks.flatMap((b: Obj) =>
            b.source_refs.map((r: Obj) => r.source_version_id),
          ),
        ),
      ]);
      data.courses = courses;
      data.topics = topics;
      data.cards = cards;
      data.versions = s
        .all("versions", true)
        .filter((v) => versionIds.has(v.id));
      data.sources = s
        .all("sources", true)
        .filter((src) =>
          data.versions.some((v: Obj) => v.source_document_id === src.id),
        );
      data.blocks = s
        .all("blocks", true)
        .filter((b) => versionIds.has(b.source_version_id));
      if (notes.length) {
        data.notes = notes;
        data.reviews = s
          .all("reviews")
          .filter((r) => r.note_ids.every((i: string) => ids.includes(i)));
        data.relations = s
          .all("relations")
          .filter((r) => ids.includes(r.from_id) && ids.includes(r.to_id));
      }
    }
    const redactions = a.redactions ?? [];
    check(
      Array.isArray(redactions) &&
        redactions.length <= 100 &&
        redactions.every(
          (v) => typeof v === "string" && v.length > 0 && v.length < 1000,
        ),
      "VALIDATION_ERROR",
      "脱敏词格式错误。",
    );
    let json = JSON.stringify(data, null, 2);
    if (a.share)
      for (const value of redactions)
        json = json.split(value).join("【已隐去】");
    const zip = new AdmZip();
    zip.addFile("data.json", Buffer.from(json));
    zip.addFile(
      "README.md",
      Buffer.from(
        "# 学习工作台导出\n\nUTF-8。data.json 保留对象 ID、来源与修订。此导出是可迁移阅读包，不是全库恢复备份。重新写入资料需要映射为 manifest.json 的课程/知识草稿并审核。个人记录仅在明确选择记录或全部范围时包含。\n",
      ),
    );
    const obj = JSON.parse(json);
    for (const type of ["courses", "topics", "cards", "notes", "reviews"])
      for (const item of obj[type] ?? []) {
        const md = `# ${item.title ?? item.original_name ?? "记录"}\n\nID: ${item.id}\n\n${item.body_md ?? item.original_text ?? item.overview ?? item.blocks?.map((b: Obj) => b.body_md).join("\n\n") ?? ""}\n`;
        zip.addFile(`${type}/${item.id}.md`, Buffer.from(md));
      }
    if (!a.share)
      for (const v of data.versions ?? [])
        zip.addFile(v.file_path, readFileSync(join(s.dir, v.file_path)));
    const id = uid("export"),
      filename = `学习工作台_${a.scope}_${id.slice(-8)}.zip`;
    const file = join(s.dir, "exports", id + ".zip");
    writeFileSync(file, zip.toBuffer(), { mode: 0o600 });
    s.setting(`download:${id}`, { file, filename });
    return {
      id,
      filename,
      download_url: `/api/download/${id}`,
      preview: json,
      warnings: a.share
        ? [
            "分享包不包含原始文件；请逐项检查脱敏预览，指定词替换无法自动识别所有隐私。",
          ]
        : [],
    };
  }
}
