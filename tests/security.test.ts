import { comparedReviewArgs } from "./review-args.js";
import assert from "node:assert/strict";
import AdmZip from "adm-zip";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
const demoMarkdown = `# DEMO 多主题课程\n\n> DEMO 模拟文本，仅用于安全和导入测试，不是用户课程材料。\n\n## 主题甲\n\n本主题甲的来源段落用于建立可追溯引用。\n\n## 主题乙\n\n本主题乙保留条件：练习后仍需继续观察。\n`;

async function withService(
  run: (service: Service, dir: string) => Promise<void>,
) {
  const dir = await mkdtemp(join(tmpdir(), "learning-workbench-security-"));
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
  const checkedArgs = await comparedReviewArgs(service, tool, args, actor);
  const result = await invoke(service, tool, checkedArgs, actor);
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

function upload(name: string, body: Buffer | string) {
  const bytes = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  return { name, content_base64: bytes.toString("base64") };
}

function archive(entries: Array<{ name: string; body: Buffer | string }>) {
  const zip = new AdmZip();
  for (const item of entries) {
    zip.addFile(
      item.name,
      typeof item.body === "string"
        ? Buffer.from(item.body, "utf8")
        : item.body,
    );
  }
  return zip.toBuffer();
}

async function importText(service: Service, name: string, text: string) {
  const preview = await data(service, "preview_import", {
    files: [upload(name, text)],
    source_kind: "cleaned_transcript",
    series: "DEMO 安全测试",
  });
  const commit = await data(service, "commit_import", {
    preview_id: preview.id,
  });
  return { preview, commit };
}

test("accepts DEMO TXT, JSON package manifest, and ZIP; reports unsupported files without importing them", async () => {
  await withService(async (service) => {
    const directTxt = "DEMO TXT：两行来源文本。\n第二行保留原始内容。\n";
    const jsonManifest = JSON.stringify({
      schema_version: "1.0.0",
      kind: "learning_workbench_import",
      sources: [{ path: "from_json.md" }],
    });
    const archiveBytes = archive([
      {
        name: "from_zip.md",
        body: "# DEMO ZIP 来源\n\n压缩包内的来源段落。\n",
      },
    ]);
    const preview = await data(service, "preview_import", {
      files: [
        upload("direct.txt", directTxt),
        upload("manifest.json", jsonManifest),
        upload("from_json.md", "# DEMO JSON 来源\n\nJSON 清单指向的正文。\n"),
        upload("bundle.zip", archiveBytes),
        upload("unsupported.pdf", "%PDF-unsupported-demo"),
      ],
      source_kind: "other",
      series: "DEMO 安全测试",
    });
    const byName = new Map(preview.items.map((item: any) => [item.name, item]));
    assert.equal((byName.get("direct.txt") as any).status, "ready");
    assert.equal((byName.get("manifest.json") as any).type, "package");
    assert.equal((byName.get("from_json.md") as any).status, "ready");
    assert.equal((byName.get("from_zip.md") as any).status, "ready");
    assert.equal((byName.get("unsupported.pdf") as any).status, "unsupported");

    const committed = await data(service, "commit_import", {
      preview_id: preview.id,
    });
    assert.ok(
      committed.imported.length >= 3,
      "plain TXT, JSON package source, and ZIP source should import",
    );
    assert.ok(
      committed.skipped.some((item: any) => item.name === "unsupported.pdf"),
    );
    const courses = await data(service, "list_courses");
    assert.ok(
      courses.items.some((course: any) => course.title.includes("DEMO")),
    );
    assert.ok(
      !courses.items.some((course: any) =>
        course.title.includes("unsupported"),
      ),
    );
  });
});

test("rejects ZIP traversal, symbolic links, and oversized entries before import", async () => {
  await withService(async (service) => {
    // AdmZip normalizes names on creation, so patch both stored ZIP filenames
    // to create an actual traversal entry for the importer to inspect.
    const traversal = archive([
      { name: "abcdefghijkl", body: "# DEMO 越界\n" },
    ]);
    const safeNameBytes = Buffer.from("abcdefghijkl");
    const traversalNameBytes = Buffer.from("../escape.md");
    let nameOffset = traversal.indexOf(safeNameBytes);
    let patchedNames = 0;
    while (nameOffset >= 0) {
      traversalNameBytes.copy(traversal, nameOffset);
      patchedNames++;
      nameOffset = traversal.indexOf(
        safeNameBytes,
        nameOffset + traversalNameBytes.length,
      );
    }
    assert.equal(
      patchedNames,
      2,
      "ZIP fixture must patch the local and central-directory names",
    );
    await error(
      service,
      "preview_import",
      { files: [upload("traversal.zip", traversal)] },
      "VALIDATION_ERROR",
    );

    const symlink = archive([{ name: "DEMO_link.md", body: "target" }]);
    const centralSignature = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
    const centralOffset = symlink.indexOf(centralSignature);
    assert.notEqual(
      centralOffset,
      -1,
      "fixture ZIP must include a central-directory record",
    );
    symlink.writeUInt32LE((0o120777 << 16) >>> 0, centralOffset + 38);
    await error(
      service,
      "preview_import",
      { files: [upload("symlink.zip", symlink)] },
      "VALIDATION_ERROR",
    );

    const oversized = archive([
      { name: "DEMO_too_large.md", body: Buffer.alloc(17 * 1024 * 1024, 0x41) },
    ]);
    await error(
      service,
      "preview_import",
      { files: [upload("oversized.zip", oversized)] },
      "PAYLOAD_TOO_LARGE",
    );
    const courses = await data(service, "list_courses");
    assert.equal(
      courses.items.length,
      0,
      "rejected archives must not create course objects",
    );
  });
});

test("course-scoped export never includes related private notes", async () => {
  await withService(async (service) => {
    const { commit } = await importText(
      service,
      "DEMO_export_course.md",
      demoMarkdown,
    );
    const courseId = commit.imported[0].course_id;
    const note = await data(service, "create_note", {
      original_text: "DEMO PRIVATE: 这段个人记录不得随课程导出。",
      type: "quick",
      relation_ids: [courseId],
      client_request_id: "demo-export-private-note-01",
    });

    const exported = await data(service, "export_data", {
      scope: "course",
      ids: [courseId],
    });
    const payload = JSON.parse(exported.preview);
    assert.equal(payload.scope, "course");
    assert.equal(Object.hasOwn(payload, "notes"), false);
    assert.equal(exported.preview.includes(note.original_text), false);
    assert.equal(exported.preview.includes("DEMO PRIVATE"), false);
  });
});

test("traditional/simplified Chinese, two-character queries, and aliases search correctly without leaking private notes to MCP", async () => {
  await withService(async (service) => {
    await error(
      service,
      "create_note",
      {
        original_text: "DEMO：外部 Agent 默认不得新增记录。",
        type: "quick",
        client_request_id: "demo-default-write-denied",
      },
      "PERMISSION_DENIED",
      "external_agent",
    );
    const note = await data(service, "create_note", {
      original_text:
        "DEMO 私人记录：脐轮练习之后，我想复习黑金心力疗愈的相关内容。",
      type: "quick",
      client_request_id: "demo-search-private-note-01",
    });

    const twoCharacter = await data(service, "search_library", {
      query: "臍輪",
      types: ["notes"],
    });
    assert.ok(
      twoCharacter.items.some((item: any) => item.id === note.id),
      "traditional two-character query should match simplified source text",
    );
    const alias = await data(service, "search_library", {
      query: "黑金心理疗愈",
      types: ["note"],
    });
    assert.ok(
      alias.items.some((item: any) => item.id === note.id),
      "known alias should find the canonical phrase",
    );

    const deniedSearch = await data(
      service,
      "search_library",
      { query: "黑金心理疗愈", types: ["note"] },
      "external_agent",
    );
    assert.equal(deniedSearch.total, 0);
    assert.ok(!deniedSearch.items.some((item: any) => item.id === note.id));
    await error(
      service,
      "get_note",
      { note_id: note.id },
      "PERMISSION_DENIED",
      "external_agent",
    );
  });
});

test("knowledge card linked across two course topics can be revised without replacing personal notes or learning state", async () => {
  await withService(async (service) => {
    const { commit } = await importText(
      service,
      "DEMO_multi_topic.md",
      demoMarkdown,
    );
    const imported = commit.imported[0];
    const course = await data(service, "get_course", {
      course_id: imported.course_id,
    });
    assert.ok(course.topics.length >= 2);
    const topicIds = course.topics.slice(0, 2).map((topic: any) => topic.id);
    const excerpt = await data(service, "get_source_excerpt", {
      source_version_id: imported.source_version_id,
      limit: 20,
    });
    const refsFor = (blocks: any[]) =>
      blocks.map((block) => ({
        source_document_id: block.source_document_id,
        source_version_id: block.source_version_id,
        source_block_id: block.id,
      }));
    const topicDrafts = topicIds.map((id: string, index: number) => {
      const topicBlocks = excerpt.blocks.filter(
        (_block: any, blockIndex: number) =>
          blockIndex % topicIds.length === index,
      );
      return {
        id,
        title: `DEMO 主题 ${index + 1}`,
        parent_id: null,
        order: index,
        content_kind: "lesson",
        blocks: [
          {
            id: `teaching_demo_${index}`,
            type: "explanation",
            body_md: `DEMO 整理内容 ${index + 1}，只用于测试主题关联。`,
            origin_kind: "ai_assisted",
            transformation: "paraphrase",
            verification_status: "needs_review",
            source_refs: refsFor(topicBlocks),
          },
        ],
      };
    });
    const coverage = excerpt.blocks.map((block: any, index: number) => ({
      source_block_id: block.id,
      disposition: "included",
      topic_ids: [topicIds[index % topicIds.length]],
    }));
    await data(service, "set_permissions", {
      permissions: {
        read_library: true,
        append_notes: false,
        save_reviews: false,
        submit_courses: true,
        submit_knowledge: true,
        propose_relations: true,
        read_note_ids: [],
      },
    });
    const courseDraft = await data(
      service,
      "submit_course_draft",
      {
        course_id: imported.course_id,
        title: "DEMO 多主题课程（审核版）",
        overview: "DEMO 多主题课程整理。",
        expected_revision: course.revision,
        source_version_ids: [imported.source_version_id],
        topics: topicDrafts,
        coverage,
        client_request_id: "demo-multi-topic-course-01",
      },
      "external_agent",
    );
    await data(service, "review_draft", {
      draft_id: courseDraft.id,
      action: "accept",
      expected_revision: courseDraft.revision,
    });

    const sourceRefs = refsFor(excerpt.blocks.slice(0, 2));
    const firstCardDraft = await data(
      service,
      "submit_knowledge_draft",
      {
        title: "DEMO 跨主题概念卡",
        type: "concept",
        body_md: "DEMO 初版知识卡内容。",
        source_refs: sourceRefs,
        topic_ids: topicIds,
        expected_revision: 0,
        client_request_id: "demo-cross-topic-card-create",
      },
      "external_agent",
    );
    await data(service, "review_draft", {
      draft_id: firstCardDraft.id,
      action: "accept",
      expected_revision: firstCardDraft.revision,
    });
    const cardBefore = await data(service, "get_knowledge_card", {
      card_id: firstCardDraft.entity_id,
    });
    assert.deepEqual(
      cardBefore.topics.map((topic: any) => topic.id).sort(),
      [...topicIds].sort(),
    );

    const note = await data(service, "create_note", {
      original_text: "DEMO 私人理解：两个主题之间有一处需要继续核对。",
      type: "understanding",
      relation_ids: [cardBefore.id],
      client_request_id: "demo-card-note-01",
    });
    const learning = await data(service, "set_learning_state", {
      object_id: cardBefore.id,
      status: "reading",
      position: { scroll: 456 },
      expected_revision: 0,
    });

    const updateDraft = await data(
      service,
      "submit_knowledge_draft",
      {
        card_id: cardBefore.id,
        title: cardBefore.title,
        type: cardBefore.type,
        body_md: "DEMO 修订版知识卡内容，保留原引用并补充限定。",
        source_refs: sourceRefs,
        topic_ids: topicIds,
        expected_revision: cardBefore.revision,
        client_request_id: "demo-cross-topic-card-update",
      },
      "external_agent",
    );
    await data(service, "review_draft", {
      draft_id: updateDraft.id,
      action: "accept",
      expected_revision: updateDraft.revision,
    });

    const cardAfter = await data(service, "get_knowledge_card", {
      card_id: cardBefore.id,
    });
    assert.equal(
      cardAfter.body_md,
      "DEMO 修订版知识卡内容，保留原引用并补充限定。",
    );
    assert.deepEqual(
      cardAfter.topics.map((topic: any) => topic.id).sort(),
      [...topicIds].sort(),
    );
    assert.ok(
      cardAfter.notes.some(
        (item: any) =>
          item.id === note.id && item.original_text === note.original_text,
      ),
    );
    assert.equal(cardAfter.learning_state.status, learning.status);
    assert.deepEqual(cardAfter.learning_state.position, learning.position);
    const oldCard = await data(service, "get_knowledge_card", {
      card_id: cardBefore.id,
      revision: cardBefore.revision,
    });
    assert.equal(
      oldCard.body_md,
      "DEMO 初版知识卡内容。",
      "historical card revision should remain readable",
    );
  });
});

test("restore rejects tampered source hashes and leaves the active data untouched", async () => {
  await withService(async (service, dir) => {
    const { commit } = await importText(
      service,
      "DEMO_restore_source.md",
      demoMarkdown,
    );
    const courseId = commit.imported[0].course_id;
    const beforeBackup = await data(service, "create_note", {
      original_text: "DEMO：哈希测试前的记录。",
      type: "quick",
      client_request_id: "demo-hash-before-01",
    });
    const backup = await data(service, "create_backup");
    const archivePath = join(dir, "backups", `${backup.id}.zip`);
    const zip = new AdmZip(await readFile(archivePath));
    const sourcePath = zip
      .getEntries()
      .find((entry) => entry.entryName.startsWith("sources/"))?.entryName;
    assert.ok(sourcePath, "backup should contain the imported source snapshot");
    zip.updateFile(
      sourcePath!,
      Buffer.from("DEMO tampered backup source content", "utf8"),
    );
    const corrupted = zip.toBuffer();

    await error(
      service,
      "preview_restore",
      { content_base64: corrupted.toString("base64") },
      "VALIDATION_ERROR",
    );
    const stillThere = await data(service, "get_note", {
      note_id: beforeBackup.id,
    });
    assert.equal(stillThere.id, beforeBackup.id);
    const stillCourse = await data(service, "get_course", {
      course_id: courseId,
    });
    assert.equal(stillCourse.id, courseId);
  });
});

test("source cursors return consecutive non-overlapping blocks, while old-version text remains fixed", async () => {
  await withService(async (service) => {
    const original =
      [
        "# DEMO 游标课程",
        "> DEMO 模拟文本，用于测试真实来源分页。",
        ...Array.from(
          { length: 24 },
          (_unused, index) =>
            `\n## DEMO 段落 ${index + 1}\n\n来源正文第 ${index + 1} 段，包含唯一编号 ${String(index + 1).padStart(2, "0")}。`,
        ),
      ].join("\n") + "\n";
    const { commit } = await importText(service, "DEMO_cursor.md", original);
    const versionId = commit.imported[0].source_version_id;
    const pages: any[] = [];
    let cursor: string | null = null;
    do {
      const page = await data(service, "get_source_excerpt", {
        source_version_id: versionId,
        cursor: cursor ?? undefined,
        limit: 3,
      });
      pages.push(page);
      cursor = page.next_cursor;
    } while (cursor);

    const pageBlocks = pages.flatMap((page) => page.blocks);
    assert.ok(pageBlocks.length >= 24);
    assert.equal(
      new Set(pageBlocks.map((block: any) => block.id)).size,
      pageBlocks.length,
      "cursor pages must not overlap",
    );
    assert.equal(pages[0].actual_range.start, 0);
    assert.equal(pages[0].actual_range.end, pages[0].blocks.length);
    for (let index = 1; index < pages.length; index++) {
      assert.equal(
        pages[index].actual_range.start,
        pages[index - 1].actual_range.end,
      );
    }
    for (const [index, block] of pageBlocks.entries())
      assert.equal(block.order, index);

    const target = pageBlocks.find((block: any) =>
      block.text.includes("唯一编号 12"),
    );
    assert.ok(target);
    const changed = original.replace(
      "来源正文第 12 段，包含唯一编号 12。",
      "新版本正文替换了第 12 段。",
    );
    assert.notEqual(
      changed,
      original,
      "DEMO fixture must actually change the target paragraph",
    );
    const updated = await importText(service, "DEMO_cursor.md", changed);
    const newVersionId = updated.commit.imported[0].source_version_id;
    assert.notEqual(newVersionId, versionId);

    const oldReference = await data(service, "get_source_excerpt", {
      source_version_id: versionId,
      source_block_id: target.id,
      limit: 1,
    });
    assert.equal(oldReference.blocks[0].text, target.text);
    assert.ok(oldReference.blocks[0].text.includes("唯一编号 12"));
    const newVersionBlocks: any[] = [];
    let newCursor: string | null = null;
    do {
      const page = await data(service, "get_source_excerpt", {
        source_version_id: newVersionId,
        cursor: newCursor ?? undefined,
        limit: 20,
      });
      newVersionBlocks.push(...page.blocks);
      newCursor = page.next_cursor;
    } while (newCursor);
    assert.ok(
      newVersionBlocks.some((block: any) =>
        block.text.includes("新版本正文替换了第 12 段。"),
      ),
    );
  });
});
