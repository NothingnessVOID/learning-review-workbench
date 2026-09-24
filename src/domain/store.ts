import { DatabaseSync } from "node:sqlite";
import {
  mkdirSync,
  chmodSync,
  writeFileSync,
  readFileSync,
  existsSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID, randomBytes } from "node:crypto";
import { AppError, check } from "./schema.js";
import * as OpenCC from "opencc-js";
const simplify = OpenCC.Converter({ from: "t", to: "cn" });
export const norm = (s: string) =>
  simplify(s)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/黑金心[理力]疗愈|黑金星力疗愈/g, "黑金心力疗愈")
    .replace(/[\s\p{P}\p{S}]+/gu, "");
export const uid = (prefix: string) =>
  `${prefix}_${randomUUID().replaceAll("-", "")}`;
export const now = () => new Date().toISOString();
export const sha = (b: Buffer | string) =>
  createHash("sha256").update(b).digest("hex");
export type Obj = Record<string, any>;
export const tables = [
  "sources",
  "versions",
  "blocks",
  "courses",
  "topics",
  "cards",
  "cases",
  "notes",
  "reviews",
  "relations",
  "learning",
  "drafts",
] as const;
export type Table = (typeof tables)[number];
export const defaultPermissions = {
  read_library: true,
  append_notes: false,
  save_reviews: false,
  submit_courses: false,
  submit_knowledge: false,
  propose_relations: false,
  read_note_ids: [] as string[],
};
export class Store {
  db: DatabaseSync;
  dbPath: string;
  constructor(public dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    for (const p of ["sources", "backups", "staging", "exports"])
      mkdirSync(join(dir, p), { recursive: true, mode: 0o700 });
    this.dbPath = join(dir, "workbench.sqlite");
    this.db = new DatabaseSync(this.dbPath, { timeout: 5000 });
    this.initialize();
    if (!existsSync(join(dir, "credentials.json"))) this.rotateToken();
  }
  initialize() {
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF;",
    );
    for (const table of tables)
      this.db.exec(
        `CREATE TABLE IF NOT EXISTS ${table}(id TEXT PRIMARY KEY, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0, parent_id TEXT, title TEXT NOT NULL DEFAULT '', search_text TEXT NOT NULL DEFAULT '', data TEXT NOT NULL CHECK(json_valid(data))); CREATE INDEX IF NOT EXISTS ${table}_parent ON ${table}(parent_id);`,
      );
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY,created_at TEXT NOT NULL,actor TEXT NOT NULL,operation TEXT NOT NULL,object_id TEXT,revision_before INTEGER,revision_after INTEGER,request_id TEXT);CREATE TABLE IF NOT EXISTS revisions(id TEXT PRIMARY KEY,table_name TEXT NOT NULL,object_id TEXT NOT NULL,revision INTEGER NOT NULL,data TEXT NOT NULL,UNIQUE(table_name,object_id,revision));CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY,body_hash TEXT NOT NULL,result TEXT NOT NULL);CREATE TABLE IF NOT EXISTS import_previews(id TEXT PRIMARY KEY,data TEXT NOT NULL);PRAGMA user_version=1;`,
    );
    if (!this.setting("permissions"))
      this.setting("permissions", defaultPermissions);
    chmodSync(this.dbPath, 0o600);
  }
  close() {
    this.db.close();
  }
  reopen() {
    this.db = new DatabaseSync(this.dbPath, { timeout: 5000 });
    this.initialize();
  }
  tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const v = fn();
      this.db.exec("COMMIT");
      return v;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  rotateToken() {
    const f = join(this.dir, "credentials.json");
    writeFileSync(
      f + ".tmp",
      JSON.stringify({ token: randomBytes(32).toString("hex") }),
      { mode: 0o600 },
    );
    renameSync(f + ".tmp", f);
  }
  token() {
    return JSON.parse(readFileSync(join(this.dir, "credentials.json"), "utf8"))
      .token as string;
  }
  setting(key: string, value?: unknown): any {
    if (value !== undefined) {
      this.db
        .prepare("INSERT OR REPLACE INTO settings VALUES(?,?)")
        .run(key, JSON.stringify(value));
      return value;
    }
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key=?")
      .get(key);
    return row ? JSON.parse(row.value as string) : null;
  }
  get(table: Table, id: string, required = true): Obj | null {
    const r = this.db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id);
    if (!r) {
      if (required) throw new AppError("NOT_FOUND", "找不到指定对象。", { id });
      return null;
    }
    return JSON.parse(r.data as string);
  }
  all(table: Table, includeArchived = false): Obj[] {
    return this.db
      .prepare(
        `SELECT data FROM ${table} ${includeArchived ? "" : "WHERE archived=0"} ORDER BY created_at DESC,id`,
      )
      .all()
      .map((r) => JSON.parse(r.data as string));
  }
  find(id: string): { table: Table; value: Obj } | null {
    for (const t of tables) {
      const v = this.get(t, id, false);
      if (v) return { table: t, value: v };
    }
    return null;
  }
  put(table: Table, value: Obj, expected?: number, immutable = false): Obj {
    const prev = this.get(table, value.id, false);
    if (expected !== undefined)
      check(
        (prev?.revision ?? 0) === expected,
        "REVISION_CONFLICT",
        "内容已经更新，请重新读取后再提交。",
        { expected, current: prev?.revision ?? 0 },
      );
    if (immutable && prev)
      throw new AppError("REVISION_CONFLICT", "来源版本与原文区段不可修改。");
    const v: Obj = {
      ...value,
      revision: (prev?.revision ?? 0) + 1,
      created_at: prev?.created_at ?? value.created_at ?? now(),
      updated_at: now(),
    };
    if (["courses", "topics", "cards", "notes", "drafts"].includes(table)) {
      v.web_path =
        "/#" +
        (
          {
            courses: "course",
            topics: "topic",
            cards: "card",
            notes: "note",
            drafts: "draft",
          } as Record<string, string>
        )[table] +
        "/" +
        v.id;
    }
    const title =
      v.title ?? v.original_name ?? v.original_text?.slice(0, 60) ?? "";
    const body = [
      title,
      v.overview,
      v.body_md,
      v.original_text,
      v.text,
      ...(v.aliases ?? []),
      ...(v.blocks ?? []).map((b: Obj) => b.body_md),
    ]
      .filter(Boolean)
      .join("\n");
    this.db
      .prepare(
        `INSERT INTO ${table}(id,revision,created_at,updated_at,archived,parent_id,title,search_text,data) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,updated_at=excluded.updated_at,archived=excluded.archived,parent_id=excluded.parent_id,title=excluded.title,search_text=excluded.search_text,data=excluded.data`,
      )
      .run(
        v.id,
        v.revision,
        v.created_at,
        v.updated_at,
        v.archived ? 1 : 0,
        v.course_id ?? v.source_version_id ?? v.parent_note_id ?? null,
        title,
        norm(body),
        JSON.stringify(v),
      );
    this.db
      .prepare("INSERT INTO revisions VALUES(?,?,?,?,?)")
      .run(uid("rev"), table, v.id, v.revision, JSON.stringify(v));
    return v;
  }
  historical(table: Table, id: string, revision?: number) {
    const current = this.get(table, id)!;
    if (revision === undefined || current.revision === revision) return current;
    const r = this.db
      .prepare(
        "SELECT data FROM revisions WHERE table_name=? AND object_id=? AND revision=?",
      )
      .get(table, id, revision);
    check(r, "NOT_FOUND", "该历史修订不存在。");
    return JSON.parse(r.data as string);
  }
  audit(
    actor: string,
    operation: string,
    id?: string,
    before?: number,
    after?: number,
    request?: string,
  ) {
    this.db
      .prepare("INSERT INTO audit VALUES(?,?,?,?,?,?,?,?)")
      .run(
        uid("audit"),
        now(),
        actor,
        operation,
        id ?? null,
        before ?? null,
        after ?? null,
        request ?? null,
      );
  }
  counts() {
    return Object.fromEntries(
      tables.map((t) => [
        t,
        Number(this.db.prepare(`SELECT count(*) n FROM ${t}`).get()!.n),
      ]),
    );
  }
}
