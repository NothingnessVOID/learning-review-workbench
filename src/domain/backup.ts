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
  statSync,
} from "node:fs";
import { join } from "node:path";
import {
  exportRuntimeContext,
  restoreRuntimeContext,
  validateContextSnapshot,
} from "./context.js";
import {
  Store,
  uid,
  sha,
  now,
  tables,
  type Obj,
  defaultPermissions,
} from "./store.js";
import { AppError, check, parse, id as idSchema } from "./schema.js";
import { unzipSafe, safeName } from "./files.js";
export const BACKUP_MAX_ENTRIES = 10_000;
export const BACKUP_MAX_EXPANDED_BYTES = 128 * 1024 * 1024;
export const BACKUP_MAX_ZIP_BYTES = 64 * 1024 * 1024;
const redactableTextFields = new Set([
  "title",
  "original_name",
  "series",
  "overview",
  "body_md",
  "original_text",
  "text",
  "description",
  "reason",
  "method_name",
  "method_version",
  "speaker",
  "aliases",
  "title_path",
  "basis",
  "gaps",
  "unresolved_questions",
  "warnings",
]);
function redactExportValue(
  value: unknown,
  terms: string[],
  field = "",
): unknown {
  if (typeof value === "string")
    return redactableTextFields.has(field)
      ? terms.reduce(
          (result, term) => result.split(term).join("【已隐去】"),
          value,
        )
      : value;
  if (Array.isArray(value))
    return value.map((item) => redactExportValue(item, terms, field));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        redactExportValue(item, terms, key),
      ]),
    );
  return value;
}
export class BackupManager {
  constructor(public store: Store) {}
  async create(options: { include_context?: boolean } = {}) {
    const s = this.store;
    const id = uid("backup");
    const stage = join(s.dir, "staging", id);
    mkdirSync(stage, { recursive: true, mode: 0o700 });
    try {
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
      const paths = new Map<string, string>();
      for (const version of versions) {
        safeName(version.file_path);
        check(
          /^sources\/[a-f0-9]{64}\.bin$/.test(version.file_path),
          "SOURCE_REF_INVALID",
          "来源快照路径格式无效。",
        );
        const previous = paths.get(version.file_path);
        check(
          !previous || previous === version.content_hash,
          "SOURCE_REF_INVALID",
          "来源版本哈希与文件路径冲突。",
        );
        paths.set(version.file_path, version.content_hash);
      }
      const runtimeContext = options.include_context
        ? exportRuntimeContext(s.dir)
        : null;
      const entryCount =
        paths.size + 2 + (runtimeContext ? 1 : 0) + (paths.size ? 1 : 0); // SQLite, manifest, optional context and directory.
      check(
        entryCount <= BACKUP_MAX_ENTRIES,
        "PAYLOAD_TOO_LARGE",
        `来源文件过多：备份最多允许 ${BACKUP_MAX_ENTRIES} 个 ZIP 条目。`,
      );
      let expandedBytes = statSync(dbFile).size;
      check(
        expandedBytes <= BACKUP_MAX_EXPANDED_BYTES,
        "PAYLOAD_TOO_LARGE",
        "数据库已超过 128 MiB 备份恢复上限。",
      );
      for (const [path] of paths) {
        const full = join(s.dir, path);
        check(existsSync(full), "NOT_FOUND", "备份失败：来源文件缺失。", {
          path,
        });
        expandedBytes += statSync(full).size;
        check(
          expandedBytes <= BACKUP_MAX_EXPANDED_BYTES,
          "PAYLOAD_TOO_LARGE",
          "数据库与来源合计超过 128 MiB 备份恢复上限。",
        );
      }
      const zip = new AdmZip();
      const files: Obj[] = [];
      const add = (name: string, bytes: Buffer) => {
        zip.addFile(name, bytes);
        files.push({ path: name, sha256: sha(bytes), size: bytes.length });
      };
      add("workbench.sqlite", readFileSync(dbFile));
      for (const [path, expectedHash] of paths) {
        const bytes = readFileSync(join(s.dir, path));
        check(
          sha(bytes) === expectedHash,
          "SOURCE_REF_INVALID",
          "备份失败：当前来源文件内容已损坏。",
          { path },
        );
        add(path, bytes);
      }
      if (runtimeContext)
        add(
          "runtime-context.json",
          Buffer.from(JSON.stringify(runtimeContext)),
        );
      const manifest = Buffer.from(
        JSON.stringify(
          {
            schema_version: "1.0.0",
            kind: "learning_workbench_backup",
            created_at: now(),
            includes_runtime_context: Boolean(runtimeContext),
            counts,
            files,
          },
          null,
          2,
        ),
      );
      expandedBytes =
        files.reduce((sum, item) => sum + item.size, 0) + manifest.length;
      check(
        expandedBytes <= BACKUP_MAX_EXPANDED_BYTES,
        "PAYLOAD_TOO_LARGE",
        "备份展开体积超过 128 MiB 恢复上限。",
      );
      zip.addFile("manifest.json", manifest);
      check(
        zip.getEntries().length <= BACKUP_MAX_ENTRIES,
        "PAYLOAD_TOO_LARGE",
        `备份条目超过 ${BACKUP_MAX_ENTRIES} 项恢复上限。`,
      );
      const archive = zip.toBuffer();
      check(
        archive.length <= BACKUP_MAX_ZIP_BYTES,
        "PAYLOAD_TOO_LARGE",
        "备份压缩体积超过 64 MiB 上传上限，请先整理数据后重试。",
      );
      const filename = `学习工作台备份_${new Date().toISOString().replaceAll(":", "-")}.zip`;
      const file = join(s.dir, "backups", id + ".zip");
      writeFileSync(file, archive, { mode: 0o600 });
      s.setting(`download:${id}`, { file, filename });
      return {
        id,
        filename,
        download_url: `/api/download/${id}`,
        counts,
        includes_runtime_context: Boolean(runtimeContext),
      };
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  }
  previewRestore(content: string) {
    check(
      typeof content === "string" &&
        content.length <= 4 * Math.ceil(BACKUP_MAX_ZIP_BYTES / 3),
      "PAYLOAD_TOO_LARGE",
      "备份体积超过上限。",
    );
    const archive = Buffer.from(content, "base64");
    check(
      archive.length <= BACKUP_MAX_ZIP_BYTES,
      "PAYLOAD_TOO_LARGE",
      "备份压缩体积超过 64 MiB 上传上限。",
    );
    const files = unzipSafe(
      archive,
      BACKUP_MAX_EXPANDED_BYTES,
      BACKUP_MAX_ENTRIES,
    );
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
            f.path === "runtime-context.json" ||
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
      if (names.has("runtime-context.json")) {
        try {
          validateContextSnapshot(
            JSON.parse(readFileSync(join(dir, "runtime-context.json"), "utf8")),
          );
        } catch (error) {
          if (error instanceof AppError) throw error;
          throw new AppError("VALIDATION_ERROR", "运行上下文快照无法解析。");
        }
      }
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
  private async createDamagedRescue(reason?: string) {
    const s = this.store,
      id = uid("rescue"),
      dir = join(s.dir, "backups", id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      await backup(s.db, join(dir, "workbench.sqlite"));
      chmodSync(join(dir, "workbench.sqlite"), 0o600);
      const issues: Obj[] = reason ? [{ problem: reason }] : [],
        copied: Obj[] = [];
      const paths = new Map<string, string>();
      for (const version of s.all("versions", true))
        paths.set(version.file_path, version.content_hash);
      for (const [path, expected] of paths) {
        safeName(path);
        check(
          /^sources\/[a-f0-9]{64}\.bin$/.test(path),
          "SOURCE_REF_INVALID",
          "当前来源路径不安全，不能建立抢救副本。",
        );
        const source = join(s.dir, path);
        if (!existsSync(source)) {
          issues.push({ path, problem: "missing" });
          continue;
        }
        const bytes = readFileSync(source);
        if (sha(bytes) !== expected)
          issues.push({
            path,
            problem: "hash_mismatch",
            actual_sha256: sha(bytes),
          });
        mkdirSync(join(dir, "sources"), { recursive: true, mode: 0o700 });
        writeFileSync(join(dir, path), bytes, { mode: 0o600 });
        copied.push({ path, sha256: sha(bytes), size: bytes.length });
      }
      writeFileSync(
        join(dir, "manifest.json"),
        JSON.stringify(
          {
            kind: "learning_workbench_damaged_rescue",
            complete: false,
            created_at: now(),
            issues,
            copied,
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
      return { filename: id, kind: "damaged_rescue", rescue_path: dir, issues };
    } catch (error) {
      rmSync(dir, { recursive: true, force: true });
      throw error;
    }
  }
  async restore(id: string) {
    const info = this.store.setting(`restore:${id}`);
    check(info, "NOT_FOUND", "恢复预览不存在，请重新上传。");
    // The preview is persisted between calls. Load and verify the exact bytes
    // that will be installed so a changed staging file cannot bypass preview.
    const verified = new Map<string, Buffer>();
    check(
      info.manifest?.files instanceof Array &&
        typeof info.dir === "string" &&
        info.dir === join(this.store.dir, "staging", id),
      "VALIDATION_ERROR",
      "恢复预览记录无效，请重新上传。",
    );
    for (const f of info.manifest.files) {
      check(
        typeof f.path === "string" &&
          (f.path === "workbench.sqlite" ||
            f.path === "runtime-context.json" ||
            /^sources\/[a-f0-9]{64}\.bin$/.test(f.path)) &&
          !verified.has(f.path),
        "VALIDATION_ERROR",
        "恢复暂存文件路径无效，请重新上传。",
      );
      const file = join(info.dir, f.path);
      check(existsSync(file), "NOT_FOUND", "恢复暂存文件已丢失，请重新上传。");
      const bytes = readFileSync(file);
      check(
        bytes.length === f.size && sha(bytes) === f.sha256,
        "VALIDATION_ERROR",
        "恢复暂存文件已变化，请重新上传。",
      );
      verified.set(f.path, bytes);
    }
    check(
      verified.has("workbench.sqlite"),
      "VALIDATION_ERROR",
      "恢复暂存数据库缺失。",
    );
    let restoreContext: unknown = null;
    if (verified.has("runtime-context.json")) {
      try {
        restoreContext = JSON.parse(
          verified.get("runtime-context.json")!.toString("utf8"),
        );
        validateContextSnapshot(restoreContext);
      } catch {
        throw new AppError(
          "VALIDATION_ERROR",
          "恢复暂存运行上下文无效，请重新上传。",
        );
      }
    }
    let prior: Obj;
    try {
      prior = await this.create();
    } catch (error) {
      if (
        !(error instanceof AppError) ||
        !(
          (error.code === "NOT_FOUND" &&
            error.message.includes("来源文件缺失")) ||
          (error.code === "SOURCE_REF_INVALID" &&
            error.message.includes("当前来源文件内容已损坏")) ||
          error.code === "PAYLOAD_TOO_LARGE"
        )
      )
        throw error;
      prior = await this.createDamagedRescue(
        error.code === "PAYLOAD_TOO_LARGE"
          ? "normal_backup_capacity_exceeded"
          : undefined,
      );
    }
    const s = this.store;
    const original = join(s.dir, "backups", uid("before_restore") + ".sqlite");
    const sourceRollbackDir = join(s.dir, "staging", uid("restore_rollback"));
    mkdirSync(sourceRollbackDir, { recursive: true, mode: 0o700 });
    const changedSources: { dest: string; previous: string | null }[] = [];
    let contextChange: ReturnType<typeof restoreRuntimeContext> | null = null;
    let dbOpen = true;
    let dbReplaced = false;
    try {
      s.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      s.close();
      dbOpen = false;
      copyFileSync(s.dbPath, original);
      for (const f of info.manifest.files) {
        if (f.path.startsWith("sources/")) {
          const dest = join(s.dir, f.path);
          if (existsSync(dest) && sha(readFileSync(dest)) === f.sha256)
            continue;
          const previous = existsSync(dest)
            ? join(sourceRollbackDir, uid("source") + ".bin")
            : null;
          if (previous) copyFileSync(dest, previous);
          const temporary = dest + ".restore-" + uid("tmp");
          changedSources.push({ dest, previous });
          try {
            writeFileSync(temporary, verified.get(f.path)!, { mode: 0o600 });
            renameSync(temporary, dest);
          } finally {
            rmSync(temporary, { force: true });
          }
        }
      }
      const next = s.dbPath + ".restore";
      writeFileSync(next, verified.get("workbench.sqlite")!, { mode: 0o600 });
      rmSync(s.dbPath + "-wal", { force: true });
      rmSync(s.dbPath + "-shm", { force: true });
      renameSync(next, s.dbPath);
      dbReplaced = true;
      s.reopen();
      dbOpen = true;
      if (restoreContext)
        contextChange = restoreRuntimeContext(s.dir, restoreContext);
      s.db
        .prepare("DELETE FROM settings WHERE key LIKE ? OR key LIKE ?")
        .run("download:%", "restore:%");
      s.setting("permissions", defaultPermissions);
      s.audit("local_user", "restore_backup");
      contextChange?.commit();
      // Cleanup cannot turn a committed restore into a failed restore.
      try {
        rmSync(info.dir, { recursive: true, force: true });
      } catch {}
      try {
        rmSync(sourceRollbackDir, { recursive: true, force: true });
      } catch {}
      return {
        restored: true,
        previous_backup: prior.filename,
        previous_backup_kind: prior.kind ?? "complete",
        rescue_path: prior.rescue_path ?? null,
        warnings:
          prior.kind === "damaged_rescue"
            ? [
                "恢复前的当前资料无法生成完整备份；已保留标记为不完整的抢救副本。",
              ]
            : [],
      };
    } catch (e) {
      const rollbackErrors: string[] = [];
      try {
        contextChange?.rollback();
      } catch {
        rollbackErrors.push("runtime-context");
      }
      if (dbOpen)
        try {
          s.close();
          dbOpen = false;
        } catch {
          rollbackErrors.push("close-db");
        }
      try {
        if (existsSync(original)) {
          const temporary = s.dbPath + ".rollback-" + uid("tmp");
          copyFileSync(original, temporary);
          rmSync(s.dbPath + "-wal", { force: true });
          rmSync(s.dbPath + "-shm", { force: true });
          renameSync(temporary, s.dbPath);
        } else if (dbReplaced) rollbackErrors.push("database-snapshot");
      } catch {
        rollbackErrors.push("database");
      }
      for (const item of changedSources.reverse()) {
        try {
          if (item.previous) {
            const temporary = item.dest + ".rollback-" + uid("tmp");
            copyFileSync(item.previous, temporary);
            renameSync(temporary, item.dest);
          } else rmSync(item.dest, { force: true });
        } catch {
          rollbackErrors.push("source");
        }
      }
      if (!rollbackErrors.length)
        try {
          rmSync(sourceRollbackDir, { recursive: true, force: true });
        } catch {}
      if (!dbOpen)
        try {
          s.reopen();
          dbOpen = true;
        } catch {
          rollbackErrors.push("reopen-db");
        }
      if (rollbackErrors.length)
        throw new AppError(
          "SERVICE_UNAVAILABLE",
          "恢复失败，自动回滚未完成；已保留恢复前快照以便人工修复。",
          {
            original_error: e instanceof AppError ? e.code : "INTERNAL_ERROR",
            rollback_steps: rollbackErrors,
            database_snapshot: original,
            source_snapshot_dir: sourceRollbackDir,
          },
        );
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
    const obj = a.share ? (redactExportValue(data, redactions) as Obj) : data;
    const json = JSON.stringify(obj, null, 2);
    JSON.parse(json); // Preview and archive share one valid structured representation.
    const zip = new AdmZip();
    zip.addFile("data.json", Buffer.from(json));
    zip.addFile(
      "README.md",
      Buffer.from(
        "# 学习工作台导出\n\nUTF-8。data.json 保留对象 ID、来源与修订。此导出是可迁移阅读包，不是全库恢复备份。重新写入资料需要映射为 manifest.json 的课程/知识草稿并审核。个人记录仅在明确选择记录或全部范围时包含。\n",
      ),
    );
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
      parameters: {
        scope: a.scope,
        ids: [...ids],
        share: Boolean(a.share),
        redactions: [...redactions],
      },
      warnings: a.share
        ? [
            "分享包不包含原始文件；请逐项检查脱敏预览，指定词替换无法自动识别所有隐私。",
          ]
        : [],
    };
  }
}
