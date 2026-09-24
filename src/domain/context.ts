import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  rmSync,
  lstatSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { check } from "./schema.js";
import { sha } from "./store.js";

export const contextSections = {
  user: "docs/USER_CONTEXT.md",
  worldview: "docs/WORLDVIEW_CONTEXT.md",
  heijin: "docs/HEIJIN_CONTEXT.md",
  rules: "docs/CONTENT_RULES.md",
  course: "prompts/course.md",
  knowledge: "prompts/knowledge.md",
  learning: "prompts/learning.md",
  review: "prompts/review.md",
} as const;
type Section = keyof typeof contextSections;
type ContextEntry = {
  text: string;
  revision: number;
  sha256: string;
  origin: string;
  updated_at: string;
};
type ContextSnapshot = {
  schema_version: 1;
  sections: Partial<Record<Section, ContextEntry>>;
};
const keys = Object.keys(contextSections) as Section[];
const folder = (dir: string) => join(dir, "runtime-context");
const empty = (): ContextSnapshot => ({ schema_version: 1, sections: {} });
function readManifest(dir: string): ContextSnapshot {
  const file = join(folder(dir), "manifest.json");
  if (!existsSync(file)) return empty();
  const value = JSON.parse(readFileSync(file, "utf8"));
  validateContextSnapshot(value);
  return value;
}
function safeRead(file: string) {
  check(
    !lstatSync(file).isSymbolicLink(),
    "VALIDATION_ERROR",
    "运行上下文不接受符号链接。",
  );
  const text = readFileSync(file, "utf8");
  check(
    Buffer.byteLength(text) <= 300000,
    "PAYLOAD_TOO_LARGE",
    "单个运行上下文超过 300 KB。",
  );
  return text;
}
function writeSnapshot(target: string, snapshot: ContextSnapshot) {
  mkdirSync(join(target, "history"), { recursive: true, mode: 0o700 });
  for (const key of keys) {
    const entry = snapshot.sections[key];
    if (!entry) continue;
    writeFileSync(join(target, `${key}.md`), entry.text, { mode: 0o600 });
    writeFileSync(
      join(target, "history", `${key}-${entry.revision}-${entry.sha256}.md`),
      entry.text,
      { mode: 0o600 },
    );
  }
  writeFileSync(
    join(target, "manifest.json.tmp"),
    JSON.stringify(snapshot, null, 2),
    { mode: 0o600 },
  );
  renameSync(join(target, "manifest.json.tmp"), join(target, "manifest.json"));
}
export function readRuntimeContext(
  dir: string,
  projectDir: string,
  selected?: string[],
) {
  const requested = selected ?? keys;
  check(
    Array.isArray(requested) &&
      requested.length <= keys.length &&
      requested.every((k) => keys.includes(k as Section)),
    "VALIDATION_ERROR",
    "未知运行上下文段落。",
  );
  const snapshot = readManifest(dir);
  let changed = false;
  for (const key of keys) {
    const current = join(folder(dir), `${key}.md`);
    const original = join(projectDir, contextSections[key]);
    const fallback = join(
      projectDir,
      "docs",
      "shareable",
      contextSections[key].split("/").at(-1)!,
    );
    const source = existsSync(current)
      ? current
      : existsSync(original)
        ? original
        : fallback;
    if (!existsSync(source)) continue;
    const text = safeRead(source),
      hash = sha(text),
      prior = snapshot.sections[key];
    if (prior?.sha256 === hash) continue;
    snapshot.sections[key] = {
      text,
      revision: (prior?.revision ?? 0) + 1,
      sha256: hash,
      origin:
        source === current
          ? "用户维护的运行上下文"
          : source === original
            ? contextSections[key]
            : `docs/shareable/${contextSections[key].split("/").at(-1)}`,
      updated_at: new Date().toISOString(),
    };
    changed = true;
  }
  if (changed) writeSnapshot(folder(dir), snapshot);
  return {
    sections: Object.fromEntries(
      requested.map((k) => [
        k,
        snapshot.sections[k as Section]?.text ?? "上下文文档尚未配置。",
      ]),
    ),
    context_version: sha(JSON.stringify(snapshot.sections)),
    context_versions: Object.fromEntries(
      requested.map((k) => {
        const entry = snapshot.sections[k as Section];
        return [k, entry ? { ...entry, text: undefined } : null];
      }),
    ),
    context_scope: "只包含语境和提示模板；不代表已安装完整方法 Skill。",
  };
}
export function validateContextSnapshot(
  value: unknown,
): asserts value is ContextSnapshot {
  const v = value as ContextSnapshot;
  check(
    v?.schema_version === 1 &&
      v.sections &&
      typeof v.sections === "object" &&
      !Array.isArray(v.sections),
    "VALIDATION_ERROR",
    "运行上下文快照格式错误。",
  );
  check(
    Object.keys(v).every((k) => ["schema_version", "sections"].includes(k)),
    "VALIDATION_ERROR",
    "运行上下文快照存在未允许的字段。",
  );
  check(
    Object.keys(v.sections).every((k) => keys.includes(k as Section)),
    "VALIDATION_ERROR",
    "运行上下文包含未允许的段落。",
  );
  for (const entry of Object.values(v.sections)) {
    check(
      entry &&
        Object.keys(entry).every((k) =>
          ["text", "revision", "sha256", "origin", "updated_at"].includes(k),
        ),
      "VALIDATION_ERROR",
      "运行上下文段落存在未允许的字段。",
    );
    check(
      entry &&
        typeof entry.text === "string" &&
        Buffer.byteLength(entry.text) <= 300000 &&
        Number.isInteger(entry.revision) &&
        entry.revision > 0 &&
        entry.sha256 === sha(entry.text) &&
        typeof entry.origin === "string" &&
        entry.origin.length <= 500 &&
        typeof entry.updated_at === "string" &&
        Number.isFinite(Date.parse(entry.updated_at)),
      "VALIDATION_ERROR",
      "运行上下文校验失败。",
    );
  }
}
export function exportRuntimeContext(dir: string) {
  if (!existsSync(join(folder(dir), "manifest.json"))) return null;
  const snapshot = readManifest(dir);
  // Export only the fixed, validated fields; never arbitrary files or credentials.
  for (const key of keys) {
    const entry = snapshot.sections[key],
      path = join(folder(dir), `${key}.md`);
    if (!entry || !existsSync(path)) continue;
    const text = safeRead(path);
    if (sha(text) !== entry.sha256)
      snapshot.sections[key] = {
        ...entry,
        text,
        sha256: sha(text),
        revision: entry.revision + 1,
        updated_at: new Date().toISOString(),
      };
  }
  validateContextSnapshot(snapshot);
  return snapshot;
}
export function restoreRuntimeContext(dir: string, value: unknown) {
  validateContextSnapshot(value);
  const target = folder(dir),
    suffix = randomUUID();
  const stage = join(dir, `context-stage-${suffix}`),
    previous = join(dir, `context-previous-${suffix}`);
  const hadPrevious = existsSync(target);
  try {
    writeSnapshot(stage, value);
    if (hadPrevious) renameSync(target, previous);
    renameSync(stage, target);
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    if (existsSync(previous)) {
      rmSync(target, { recursive: true, force: true });
      renameSync(previous, target);
    }
    throw error;
  }
  let done = false;
  return {
    rollback() {
      if (done) return;
      rmSync(target, { recursive: true, force: true });
      if (hadPrevious) renameSync(previous, target);
      done = true;
    },
    commit() {
      if (done) return;
      if (hadPrevious && existsSync(previous)) {
        const archive = join(dir, "runtime-context-history");
        mkdirSync(archive, { recursive: true, mode: 0o700 });
        renameSync(previous, join(archive, suffix));
      }
      done = true;
    },
  };
}
