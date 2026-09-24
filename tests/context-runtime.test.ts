import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readRuntimeContext,
  exportRuntimeContext,
  restoreRuntimeContext,
  validateContextSnapshot,
} from "../src/domain/context.js";
import {
  fingerprints,
  isCurrentBuild,
  writeBuild,
} from "../scripts/build-info.mjs";
test("M04 versioned runtime context, explicit snapshot, restore and rollback exclude credentials", () => {
  const root = mkdtempSync(join(tmpdir(), "wb-context-"));
  try {
    const project = join(root, "project"),
      data = join(root, "data"),
      next = join(root, "next");
    mkdirSync(join(project, "docs"), { recursive: true });
    mkdirSync(data);
    mkdirSync(next);
    writeFileSync(join(project, "docs/USER_CONTEXT.md"), "Original context");
    writeFileSync(join(data, "credentials.json"), "DO_NOT_EXPORT");
    const a = readRuntimeContext(data, project, ["user"]);
    assert.equal(a.sections.user, "Original context");
    assert.equal(a.context_versions.user?.revision, 1);
    writeFileSync(
      join(data, "runtime-context/user.md"),
      "User changed context",
    );
    const b = readRuntimeContext(data, project, ["user"]);
    assert.equal(b.context_versions.user?.revision, 2);
    assert.notEqual(a.context_version, b.context_version);
    const snapshot = exportRuntimeContext(data)!;
    assert(!JSON.stringify(snapshot).includes("DO_NOT_EXPORT"));
    const restore = restoreRuntimeContext(next, snapshot);
    assert.equal(
      readFileSync(join(next, "runtime-context/user.md"), "utf8"),
      "User changed context",
    );
    restore.rollback();
    assert.equal(existsSync(join(next, "runtime-context")), false);
    restoreRuntimeContext(next, snapshot).commit();
    assert.equal(
      readRuntimeContext(next, project, ["user"]).sections.user,
      "User changed context",
    );
    assert.throws(() =>
      validateContextSnapshot({
        ...snapshot,
        sections: { ...snapshot.sections, credentials: { text: "bad" } },
      }),
    );
    assert.throws(() =>
      validateContextSnapshot({
        ...snapshot,
        sections: { user: { ...snapshot.sections.user, sha256: "bad" } },
      }),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("E03 build fingerprint detects source and lock changes and ignores unrelated notes", () => {
  const root = mkdtempSync(join(tmpdir(), "wb-fingerprint-"));
  try {
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "scripts"));
    writeFileSync(join(root, "src/a.ts"), "export const a=1");
    writeFileSync(join(root, "package.json"), '{"version":"test"}');
    writeFileSync(join(root, "package-lock.json"), "{}");
    const built = writeBuild(root);
    assert(isCurrentBuild(built, fingerprints(root)));
    writeFileSync(join(root, "notes.md"), "unrelated");
    assert(isCurrentBuild(built, fingerprints(root)));
    writeFileSync(join(root, "src/a.ts"), "export const a=2");
    assert(!isCurrentBuild(built, fingerprints(root)));
    const current = writeBuild(root);
    writeFileSync(join(root, "package-lock.json"), '{"changed":true}');
    assert(!isCurrentBuild(current, fingerprints(root)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
