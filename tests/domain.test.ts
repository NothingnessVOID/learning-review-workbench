import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Service } from "../src/domain/service.js";

type Actor = "local_user" | "external_agent";
type Rpc = {
  ok: boolean;
  data?: any;
  error?: { code: string; message: string; details?: unknown };
};

const projectDir = process.cwd();
const demoMarkdown = `# DEMO：声音练习课程\n\n> DEMO 模拟文本，仅用于测试，不是用户课程材料。\n\n## 主题甲\n\n讲者在此处介绍一项练习，并说明参与者需要结合自己的行动。\n\n## 主题乙\n\n本段保留条件：只有在愿意实际练习时，才讨论后续变化。\n`;

async function withService(
  run: (service: Service, dir: string) => Promise<void>,
) {
  const dir = await mkdtemp(join(tmpdir(), "learning-workbench-domain-"));
  const service = new Service(dir, projectDir);
  try {
    await run(service, dir);
  } finally {
    service.store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

async function invoke(
  service: Service,
  tool: string,
  args: unknown = {},
  actor: Actor = "local_user",
) {
  return (await service.invoke(tool, args, actor)) as Rpc;
}

async function data(
  service: Service,
  tool: string,
  args: unknown = {},
  actor: Actor = "local_user",
) {
  const result = await invoke(service, tool, args, actor);
  assert.equal(
    result.ok,
    true,
    `${tool} failed: ${JSON.stringify(result.error)}`,
  );
  return result.data;
}

async function error(
  service: Service,
  tool: string,
  args: unknown,
  code: string,
  actor: Actor = "local_user",
) {
  const result = await invoke(service, tool, args, actor);
  assert.equal(result.ok, false, `${tool} unexpectedly succeeded`);
  assert.equal(
    result.error?.code,
    code,
    `${tool} returned an unexpected error`,
  );
  return result.error;
}

function uploaded(name: string, text: string) {
  return { name, content_base64: Buffer.from(text, "utf8").toString("base64") };
}

async function importMarkdown(
  service: Service,
  text: string,
  name = "DEMO_声音练习.md",
) {
  const preview = await data(service, "preview_import", {
    files: [uploaded(name, text)],
    source_kind: "cleaned_transcript",
    series: "DEMO 测试课程",
  });
  const committed = await data(service, "commit_import", {
    preview_id: preview.id,
  });
  return { preview, committed };
}

test("Markdown preview/commit, repeated import, and new source version keep old excerpts", async () => {
  await withService(async (service) => {
    const first = await data(service, "preview_import", {
      files: [uploaded("DEMO_声音练习.md", demoMarkdown)],
      source_kind: "cleaned_transcript",
      series: "DEMO 测试课程",
    });
    assert.equal(first.items.length, 1);
    assert.equal(first.items[0].status, "ready");
    assert.equal(first.counts.sources, 1);

    const committed = await data(service, "commit_import", {
      preview_id: first.id,
    });
    assert.equal(committed.imported.length, 1);
    const imported = committed.imported[0];
    assert.ok(imported.source_version_id);
    const oldExcerpt = await data(service, "get_source_excerpt", {
      source_version_id: imported.source_version_id,
      limit: 20,
    });
    assert.ok(
      oldExcerpt.blocks.length >= 2,
      "DEMO fixture must create multiple source blocks",
    );
    assert.ok(
      oldExcerpt.blocks.some((block: any) => block.text.includes("条件")),
    );
    const oldBlockIds = oldExcerpt.blocks.map((block: any) => block.id);

    const repeatedPreview = await data(service, "preview_import", {
      files: [uploaded("DEMO_声音练习.md", demoMarkdown)],
      source_kind: "cleaned_transcript",
      series: "DEMO 测试课程",
    });
    assert.equal(repeatedPreview.items[0].status, "duplicate");
    const repeatedCommit = await data(service, "commit_import", {
      preview_id: repeatedPreview.id,
    });
    assert.equal(repeatedCommit.skipped.length, 1);
    assert.equal(repeatedCommit.imported.length, 0);

    const revisedText = demoMarkdown.replace(
      "条件：只有在愿意实际练习时",
      "新版本条件：只有在持续复核并愿意实际练习时",
    );
    const revisedPreview = await data(service, "preview_import", {
      files: [uploaded("DEMO_声音练习.md", revisedText)],
      source_kind: "cleaned_transcript",
      series: "DEMO 测试课程",
    });
    assert.equal(revisedPreview.items[0].status, "new_version");
    const revisedCommit = await data(service, "commit_import", {
      preview_id: revisedPreview.id,
    });
    assert.equal(revisedCommit.imported.length, 1);
    const newVersionId = revisedCommit.imported[0].source_version_id;
    assert.notEqual(newVersionId, imported.source_version_id);

    const historicalExcerpt = await data(service, "get_source_excerpt", {
      source_version_id: imported.source_version_id,
      limit: 20,
    });
    assert.deepEqual(
      historicalExcerpt.blocks.map((block: any) => block.id),
      oldBlockIds,
    );
    assert.ok(
      historicalExcerpt.blocks.some((block: any) =>
        block.text.includes("只有在愿意实际练习时"),
      ),
    );
    const currentExcerpt = await data(service, "get_source_excerpt", {
      source_version_id: newVersionId,
      limit: 20,
    });
    assert.ok(
      currentExcerpt.blocks.some((block: any) =>
        block.text.includes("持续复核"),
      ),
    );
  });
});

test("quick note idempotency, request ID conflict, selected MCP note access, and invalid source references", async () => {
  await withService(async (service) => {
    const noteArgs = {
      original_text: "DEMO：学习后想记录一次表达练习。",
      type: "quick",
      client_request_id: "demo-note-request-01",
    };
    const first = await data(service, "create_note", noteArgs, "local_user");
    const retry = await data(service, "create_note", noteArgs, "local_user");
    assert.equal(
      retry.id,
      first.id,
      "retry with identical request ID and body must return the original note",
    );
    assert.equal(retry.revision, first.revision);

    await error(
      service,
      "create_note",
      {
        ...noteArgs,
        original_text: "DEMO：同一请求 ID 不得覆盖成另一条记录。",
      },
      "DUPLICATE_REQUEST_CONFLICT",
      "local_user",
    );

    await error(
      service,
      "get_note",
      { note_id: first.id },
      "PERMISSION_DENIED",
      "external_agent",
    );
    const permissions = {
      read_library: true,
      append_notes: false,
      save_reviews: false,
      submit_courses: true,
      submit_knowledge: true,
      propose_relations: true,
      read_note_ids: [first.id],
    };
    await data(service, "set_permissions", { permissions });
    const allowed = await data(
      service,
      "get_note",
      { note_id: first.id },
      "external_agent",
    );
    assert.equal(allowed.id, first.id);

    await data(service, "set_permissions", {
      permissions: { ...permissions, read_note_ids: [] },
    });
    await error(
      service,
      "get_note",
      { note_id: first.id },
      "PERMISSION_DENIED",
      "external_agent",
    );

    await error(
      service,
      "submit_knowledge_draft",
      {
        title: "DEMO 非法引用卡",
        body_md: "这条草稿故意引用不存在的来源。",
        source_refs: [
          {
            source_document_id: "src_does_not_exist",
            source_version_id: "sv_does_not_exist",
            source_block_id: "blk_does_not_exist",
          },
        ],
        expected_revision: 0,
        client_request_id: "demo-invalid-source-ref-01",
      },
      "SOURCE_REF_INVALID",
      "external_agent",
    );
  });
});

test("course coverage is complete, accepted drafts preserve user notes and learning state, and stale drafts conflict", async () => {
  await withService(async (service) => {
    const status = await data(service, "get_status");
    await data(service, "set_permissions", {
      permissions: { ...status.permissions, submit_courses: true },
    });
    const { committed } = await importMarkdown(service, demoMarkdown);
    const imported = committed.imported[0];
    const courseId = imported.course_id;
    const course = await data(service, "get_course", { course_id: courseId });
    const excerpt = await data(service, "get_source_excerpt", {
      source_version_id: imported.source_version_id,
      limit: 20,
    });
    const blocks = excerpt.blocks;
    assert.ok(
      blocks.length >= 2,
      "DEMO fixture must exercise incomplete coverage",
    );

    // The current imported course already has source-backed topics; learning
    // position must point to one that exists before the new draft is accepted.
    const topicId = course.topics[0].id;
    const topic = {
      id: topicId,
      title: "DEMO 主题：声音练习",
      parent_id: null,
      order: 0,
      content_kind: "lesson",
      blocks: [
        {
          id: "teaching_block_demo_sound",
          type: "explanation",
          body_md:
            "DEMO 整理稿：保留练习条件，并将每项说明链接到实际来源段落。",
          origin_kind: "ai_assisted",
          transformation: "paraphrase",
          verification_status: "needs_review",
          source_refs: blocks.map((block: any) => ({
            source_document_id: block.source_document_id,
            source_version_id: block.source_version_id,
            source_block_id: block.id,
          })),
        },
      ],
    };
    const coverage = blocks.map((block: any) => ({
      source_block_id: block.id,
      disposition: "included",
      topic_ids: [topicId],
    }));
    const draftArgs = {
      course_id: courseId,
      title: "DEMO 课程整理草稿",
      series: "DEMO 测试课程",
      overview: "DEMO 草稿，待本地用户审核。",
      expected_revision: course.revision,
      source_version_ids: [imported.source_version_id],
      topics: [topic],
      coverage,
      unresolved_questions: ["DEMO：确认讲义转述保留了原文限定。"],
      client_request_id: "demo-course-draft-first",
    };

    await error(
      service,
      "submit_course_draft",
      {
        ...draftArgs,
        coverage: coverage.slice(0, -1),
        client_request_id: "demo-course-draft-missing-coverage",
      },
      "SOURCE_REF_INVALID",
      "external_agent",
    );

    const firstDraft = await data(
      service,
      "submit_course_draft",
      draftArgs,
      "external_agent",
    );
    const staleDraft = await data(
      service,
      "submit_course_draft",
      {
        ...draftArgs,
        title: "DEMO 另一份并发草稿",
        client_request_id: "demo-course-draft-stale",
      },
      "external_agent",
    );
    assert.equal(firstDraft.status, "draft");
    assert.equal(staleDraft.status, "draft");

    const note = await data(service, "create_note", {
      original_text: "DEMO 私人记录：读完后准备尝试一次更清楚的表达。",
      type: "understanding",
      relation_ids: [courseId],
      client_request_id: "demo-learning-note-01",
    });
    const learning = await data(service, "set_learning_state", {
      object_id: courseId,
      status: "reading",
      position: { topic_id: topicId, scroll: 321 },
      expected_revision: 0,
    });

    const accepted = await data(service, "review_draft", {
      draft_id: firstDraft.id,
      action: "accept",
      expected_revision: firstDraft.revision,
    });
    assert.equal(accepted.status, "accepted");
    const currentCourse = await data(service, "get_course", {
      course_id: courseId,
    });
    assert.equal(currentCourse.title, "DEMO 课程整理草稿");
    assert.equal(currentCourse.learning_state.status, learning.status);
    assert.deepEqual(currentCourse.learning_state.position, learning.position);
    const notes = await data(service, "list_notes", { relation_id: courseId });
    assert.ok(
      notes.items.some(
        (item: any) =>
          item.id === note.id && item.original_text === note.original_text,
      ),
    );

    await error(
      service,
      "review_draft",
      {
        draft_id: staleDraft.id,
        action: "accept",
        expected_revision: staleDraft.revision,
      },
      "REVISION_CONFLICT",
      "local_user",
    );
  });
});

test("backup restore previews in isolation and restores only the chosen backup snapshot", async () => {
  await withService(async (service, dir) => {
    const { committed } = await importMarkdown(service, demoMarkdown);
    const courseId = committed.imported[0].course_id;
    const beforeBackup = await data(service, "create_note", {
      original_text: "DEMO：备份中应存在的记录。",
      type: "quick",
      client_request_id: "demo-backup-before-01",
    });

    const backup = await data(service, "create_backup");
    assert.ok(backup.id);
    const backupFiles = (await readdir(join(dir, "backups"))).filter(
      (name) => !name.endsWith(".tmp"),
    );
    assert.ok(
      backupFiles.length > 0,
      "create_backup must materialize a recoverable file in the managed backups directory",
    );
    const backupContents = await Promise.all(
      backupFiles.map(async (name) => ({
        name,
        bytes: await readFile(join(dir, "backups", name)),
      })),
    );
    const backupFile = backupContents
      .filter((item) => !item.name.endsWith(".sha256"))
      .sort((a, b) => b.bytes.length - a.bytes.length)[0];
    assert.ok(backupFile, "backup artifact must have readable content");

    const afterBackup = await data(service, "create_note", {
      original_text: "DEMO：恢复后应消失的记录。",
      type: "quick",
      client_request_id: "demo-backup-after-01",
    });
    const restorePreview = await data(service, "preview_restore", {
      content_base64: backupFile.bytes.toString("base64"),
    });
    assert.equal(restorePreview.valid, true);
    const stillCurrent = await data(service, "get_note", {
      note_id: afterBackup.id,
    });
    assert.equal(
      stillCurrent.id,
      afterBackup.id,
      "preview must not alter the active database",
    );

    const restored = await data(service, "commit_restore", {
      preview_id: restorePreview.id,
      confirmation: "恢复此备份",
    });
    assert.equal(restored.restored, true);
    const restoredNote = await data(service, "get_note", {
      note_id: beforeBackup.id,
    });
    assert.equal(restoredNote.id, beforeBackup.id);
    await error(
      service,
      "get_note",
      { note_id: afterBackup.id },
      "NOT_FOUND",
      "local_user",
    );
    const restoredCourse = await data(service, "get_course", {
      course_id: courseId,
    });
    assert.equal(restoredCourse.id, courseId);
  });
});
