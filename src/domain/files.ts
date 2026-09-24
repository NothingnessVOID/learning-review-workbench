import AdmZip from "adm-zip";
import { inflateRawSync } from "node:zlib";
import {
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { basename, extname, join } from "node:path";
import { check, AppError } from "./schema.js";
import { uid, sha, now, Store, type Obj } from "./store.js";
export const MAX_FILE = 8 * 1024 * 1024,
  MAX_TOTAL = 64 * 1024 * 1024,
  MAX_FILES = 1000;
export type FileItem = { name: string; buffer: Buffer };
export function safeName(name: string) {
  check(
    name.length < 700 &&
      !name.includes("\\") &&
      !name.startsWith("/") &&
      !name.includes("\0") &&
      !name.split("/").some((p) => p === "..") &&
      !/^[a-z]:/i.test(name),
    "VALIDATION_ERROR",
    "压缩包包含越界或不安全路径。",
  );
  return name;
}
export function unzipSafe(buffer: Buffer, maxTotal = MAX_TOTAL): FileItem[] {
  check(buffer.length <= maxTotal, "PAYLOAD_TOO_LARGE", "文件超过允许体积。");
  let zip: AdmZip;
  try {
    zip = new AdmZip(buffer);
  } catch {
    throw new AppError("VALIDATION_ERROR", "无法读取 ZIP 文件。");
  }
  const es = zip.getEntries();
  check(
    es.length <= MAX_FILES,
    "PAYLOAD_TOO_LARGE",
    "ZIP 文件数量超限（最多 1000 项）。",
  );
  let total = 0;
  const names = new Set<string>();
  for (const e of es) {
    safeName(e.entryName);
    check(!names.has(e.entryName), "VALIDATION_ERROR", "ZIP 中有重复路径。");
    names.add(e.entryName);
    check(
      ((e.header.attr >>> 16) & 0xf000) !== 0xa000,
      "VALIDATION_ERROR",
      "ZIP 不能包含符号链接。",
    );
    check(
      [0, 8].includes(e.header.method),
      "VALIDATION_ERROR",
      "ZIP 压缩算法不支持。",
    );
    check(!(e.header.flags & 1), "VALIDATION_ERROR", "暂不支持加密 ZIP。");
    check(
      e.header.size <= (maxTotal === MAX_TOTAL ? MAX_FILE : maxTotal),
      "PAYLOAD_TOO_LARGE",
      "ZIP 单个文件过大。",
    );
    total += e.header.size;
    check(total <= maxTotal, "PAYLOAD_TOO_LARGE", "ZIP 展开总体积过大。");
  }
  const out: FileItem[] = [];
  for (const e of es) {
    if (e.isDirectory) continue;
    let b: Buffer;
    try {
      const compressed = e.getCompressedData();
      b =
        e.header.method === 0
          ? compressed
          : inflateRawSync(compressed, {
              maxOutputLength: Math.min(e.header.size + 1, maxTotal),
            });
      check(
        b.length === e.header.size,
        "VALIDATION_ERROR",
        "ZIP 展开长度与目录不一致。",
      );
      const verified = e.getData();
      check(sha(verified) === sha(b), "VALIDATION_ERROR", "ZIP 数据校验失败。");
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw new AppError("VALIDATION_ERROR", "ZIP 数据损坏或压缩格式不支持。");
    }
    out.push({ name: e.entryName, buffer: b });
  }
  return out;
}
export function decodeUploads(files: Obj[]): FileItem[] {
  check(
    Array.isArray(files) && files.length > 0 && files.length <= MAX_FILES,
    "VALIDATION_ERROR",
    "请选择 1 至 1000 个文件。",
  );
  const result: FileItem[] = [];
  let total = 0;
  for (const f of files) {
    check(
      typeof f.name === "string" && typeof f.content_base64 === "string",
      "VALIDATION_ERROR",
      "上传文件格式错误。",
    );
    safeName(f.name);
    const b = Buffer.from(f.content_base64, "base64");
    check(b.length <= MAX_TOTAL, "PAYLOAD_TOO_LARGE", "文件超过 64 MB。");
    const parts =
      extname(f.name).toLowerCase() === ".zip"
        ? unzipSafe(b)
        : [{ name: f.name, buffer: b }];
    for (const part of parts) {
      total += part.buffer.length;
      check(
        total <= MAX_TOTAL && result.length < MAX_FILES,
        "PAYLOAD_TOO_LARGE",
        "本次导入展开后超过 64 MB 或 1000 个文件。",
      );
      result.push(part);
    }
  }
  return result;
}
export function utf8(b: Buffer) {
  try {
    return new TextDecoder("utf-8", { fatal: true })
      .decode(b)
      .replace(/^\uFEFF/, "");
  } catch {
    throw new AppError(
      "VALIDATION_ERROR",
      "文本不是有效 UTF-8，请转换编码后重试。",
    );
  }
}
export function splitSource(
  text: string,
  versionId: string,
  documentId: string,
) {
  const lines = text.split("\n");
  const blocks: Obj[] = [];
  let start = 0;
  let path: string[] = [];
  let group: string[] = [];
  const flush = (end: number) => {
    if (!group.length) return;
    blocks.push({
      id: `blk_${versionId}_${blocks.length}`,
      source_document_id: documentId,
      source_version_id: versionId,
      order: blocks.length,
      title_path: [...path],
      text: group.join("\n"),
      line_start: start + 1,
      line_end: end,
    });
    group = [];
    start = end;
  };
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(/^(#{1,6})\s+(.+)$/);
    if (h) {
      flush(i);
      path = path.slice(0, h[1].length - 1);
      path[h[1].length - 1] = h[2];
      start = i;
    }
    if (group.join("\n").length > 5000) {
      flush(i);
      start = i;
    }
    group.push(lines[i]);
    if (lines[i].trim() === "") {
      flush(i + 1);
      start = i + 1;
    }
  }
  flush(lines.length);
  return blocks;
}
export function sourcePreview(store: Store, files: Obj[], options: Obj) {
  const expanded = decodeUploads(files);
  const items: Obj[] = [];
  const entries: Obj[] = [];
  const warnings: string[] = [];
  const counts = {
    sources: 0,
    courses: 0,
    cards: 0,
    cases: 0,
    duplicates: 0,
    unsupported: 0,
  };
  const hashes = new Set([
    ...store.all("versions", true).map((v) => v.content_hash),
    ...(store.setting("import_hashes") ?? []),
  ]);
  for (const f of expanded) {
    if (f.name.startsWith("__MACOSX/") || basename(f.name).startsWith("."))
      continue;
    const ext = extname(f.name).toLowerCase();
    const hash = sha(f.buffer);
    let status = "ready",
      type = "source";
    const itemWarnings: string[] = [];
    if (![".md", ".txt", ".json"].includes(ext)) {
      status = "unsupported";
      counts.unsupported++;
      itemWarnings.push(
        "保留原文件，当前导入支持 Markdown、TXT、JSON；DOCX/PDF 请先单独提取文本。",
      );
    } else if (hashes.has(hash)) {
      status = "duplicate";
      counts.duplicates++;
    }
    let payload: any = null;
    let content = "";
    if (status === "ready") {
      try {
        content = utf8(f.buffer);
        if (ext === ".json") {
          payload = JSON.parse(content);
          if (
            payload.schema_version === "1.0.0" &&
            (payload.courses ||
              payload.knowledge ||
              payload.cases ||
              payload.sources)
          ) {
            type = "package";
            counts.courses += (payload.courses ?? []).length;
            counts.cards += (payload.knowledge ?? []).length;
            counts.cases += (payload.cases ?? []).length;
          } else if (payload.topics && payload.source_version_ids) {
            type = "course_draft";
            counts.courses++;
          } else if (payload.body_md && payload.source_refs) {
            type = "knowledge_draft";
            counts.cards++;
          } else {
            status = "unsupported";
            counts.unsupported++;
            itemWarnings.push(
              "JSON 字段未匹配工作台 schema，未当作课程静默导入。",
            );
          }
        } else {
          check(
            f.buffer.length <= MAX_FILE,
            "PAYLOAD_TOO_LARGE",
            "文本文件超过 8 MB。",
          );
          counts.sources++;
          counts.courses++;
          const same = store
            .all("sources", true)
            .find((s) => s.original_name === f.name);
          if (same) {
            status = "new_version";
            itemWarnings.push(
              "同名内容已变化，将新增不可变来源版本，保留旧引用与个人记录。",
            );
          }
          itemWarnings.push("确定性分段导入，不会自动生成学习讲义。");
        }
        if (status !== "unsupported") hashes.add(hash);
      } catch (e) {
        status = "error";
        itemWarnings.push(e instanceof Error ? e.message : "文件解析失败");
      }
    }
    items.push({
      name: f.name,
      type,
      status,
      sha256: hash,
      warnings: itemWarnings,
    });
    entries.push({
      name: f.name,
      type,
      status,
      sha256: hash,
      content_base64: f.buffer.toString("base64"),
      payload,
    });
  }
  const id = uid("import");
  const value = {
    id,
    items,
    counts,
    warnings,
    entries,
    options,
    created_at: now(),
    committed: null,
  };
  store.db
    .prepare("INSERT INTO import_previews VALUES(?,?)")
    .run(id, JSON.stringify(value));
  return { id, items, counts, warnings };
}
export function importSource(store: Store, entry: Obj, options: Obj) {
  const oldVersion = store
    .all("versions", true)
    .find((v) => v.content_hash === entry.sha256);
  if (oldVersion) return { skipped: true, id: oldVersion.id };
  const b = Buffer.from(entry.content_base64, "base64");
  check(sha(b) === entry.sha256, "VALIDATION_ERROR", "暂存文件校验失败。");
  const text = utf8(b);
  const dateMatch = text.match(
    /直播日期[：:]\s*(\d{4})年(\d{1,2})月(\d{1,2})日/,
  );
  const sourceDate = dateMatch
    ? `${dateMatch[1]}-${dateMatch[2].padStart(2, "0")}-${dateMatch[3].padStart(2, "0")}`
    : null;
  const existing = store
    .all("sources", true)
    .find((s) => s.original_name === entry.name);
  const source =
    existing ??
    store.put(
      "sources",
      {
        id: uid("src"),
        original_name: entry.name,
        source_kind: options.source_kind ?? "other",
        permission: "library",
        speaker: null,
        source_date: sourceDate,
      },
      0,
      true,
    );
  const versionId = uid("sv");
  const rel = `sources/${entry.sha256}.bin`;
  const target = join(store.dir, rel);
  if (!existsSync(target)) {
    writeFileSync(target + ".tmp", b, { mode: 0o600 });
    renameSync(target + ".tmp", target);
  }
  const version = store.put(
    "versions",
    {
      id: versionId,
      source_document_id: source.id,
      content_hash: entry.sha256,
      file_path: rel,
      imported_at: now(),
      original_name: entry.name,
      parse_status: "parsed",
      version_label: null,
    },
    0,
    true,
  );
  const blocks = splitSource(text, versionId, source.id).map((block) =>
    store.put("blocks", block, 0, true),
  );
  let course = store
    .all("courses", true)
    .find((c) => c.source_document_id === source.id);
  if (course) {
    course = store.put(
      "courses",
      {
        ...course,
        source_version_ids: [...course.source_version_ids, versionId],
        processing_status: "needs_review",
      },
      course.revision,
    );
  } else {
    const heading = text.match(/^#\s+(.+)$/m)?.[1];
    course = store.put(
      "courses",
      {
        id: uid("course"),
        source_document_id: source.id,
        title: heading ?? basename(entry.name, extname(entry.name)),
        series: options.series ?? "未分类",
        course_date: sourceDate,
        overview:
          "原始资料已保存，可按目录阅读原文。学习讲义待外部 Agent 整理并审核。",
        source_version_ids: [versionId],
        processing_status: "received",
        verification_status: "source_locatable",
        topic_count: blocks.length,
      },
      0,
    );
    for (const [i, block] of blocks.entries()) {
      store.put(
        "topics",
        {
          id: uid("topic"),
          course_id: course.id,
          parent_id: null,
          order: i,
          title: block.title_path.at(-1) ?? `原文第 ${i + 1} 段`,
          content_kind: "source_text",
          blocks: [
            {
              id: uid("tb"),
              type: "source_quote",
              body_md: block.text,
              origin_kind: options.source_kind ?? "other",
              transformation: "original_quote",
              source_refs: [
                {
                  source_document_id: source.id,
                  source_version_id: versionId,
                  source_block_id: block.id,
                },
              ],
              verification_status: "source_locatable",
            },
          ],
        },
        0,
      );
    }
  }
  return {
    id: source.id,
    source_version_id: version.id,
    course_id: course.id,
    blocks: blocks.length,
  };
}
