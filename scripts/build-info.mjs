import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
export function fingerprints(project = root) {
  const files = [];
  function walk(path) {
    for (const entry of readdirSync(join(project, path), {
      withFileTypes: true,
    })) {
      const relative = `${path}/${entry.name}`;
      if (entry.isDirectory()) walk(relative);
      else if (entry.isFile()) files.push(relative);
    }
  }
  walk("src");
  files.push(
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "vite.config.ts",
    "scripts/build-info.mjs",
    "scripts/start.mjs",
  );
  const hash = createHash("sha256");
  for (const file of files.sort()) {
    if (existsSync(join(project, file)))
      hash
        .update(file)
        .update("\0")
        .update(readFileSync(join(project, file)))
        .update("\0");
  }
  return {
    fingerprint: hash.digest("hex"),
    lock_hash: digest(readFileSync(join(project, "package-lock.json"))),
  };
}
export function readBuild(project = root) {
  try {
    return JSON.parse(
      readFileSync(join(project, "dist", "build-info.json"), "utf8"),
    );
  } catch {
    return null;
  }
}
export function isCurrentBuild(info, current) {
  return (
    !!info &&
    info.fingerprint === current.fingerprint &&
    info.lock_hash === current.lock_hash
  );
}
export function writeBuild(project = root) {
  let commit = "uncommitted";
  try {
    commit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: project,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {}
  const info = {
    ...fingerprints(project),
    version: JSON.parse(readFileSync(join(project, "package.json"), "utf8"))
      .version,
    commit,
    built_at: new Date().toISOString(),
  };
  mkdirSync(join(project, "dist"), { recursive: true });
  writeFileSync(
    join(project, "dist", "build-info.json"),
    JSON.stringify(info, null, 2),
  );
  return info;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.argv.includes("--dependencies")) {
    mkdirSync(join(root, "node_modules"), { recursive: true });
    writeFileSync(
      join(root, "node_modules", ".workbench-lock"),
      fingerprints().lock_hash,
    );
  } else console.log(JSON.stringify(writeBuild()));
}
