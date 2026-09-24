import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = resolve(import.meta.dirname, "..");
const demoDir = join(root, ".data/demo");
assert.equal(
  process.env.LEARNING_WORKBENCH_URL,
  "http://127.0.0.1:47832",
  "仅允许在 47832 演示服务测试写入",
);
assert.equal(
  resolve(process.env.LEARNING_WORKBENCH_DATA_DIR ?? ""),
  demoDir,
  "仅允许在项目 .data/demo 测试写入",
);
const base = process.env.LEARNING_WORKBENCH_URL;
const client = new Client({
  name: "learning-workbench-demo-write-test",
  version: "1.0.0",
});
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(root, "dist/stdio.js")],
  cwd: root,
  env: { ...process.env },
  stderr: "pipe",
});
let cookie;
let csrf;
let originalPermissions;
let permissionsChanged = false;

async function ui(tool, args) {
  const response = await fetch(`${base}/api/rpc`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
      "x-csrf-token": csrf,
    },
    body: JSON.stringify({ tool, args }),
  });
  const body = await response.json();
  assert.equal(
    body.ok,
    true,
    `UI ${tool}: ${body.error?.code ?? response.status}`,
  );
  return body.data;
}
async function mcp(name, args, expectedError) {
  const response = await client.callTool({ name, arguments: args });
  assert.equal(
    response.structuredContent?.ok,
    !expectedError,
    `${name}: ${response.structuredContent?.error?.code ?? "unexpected result"}`,
  );
  assert.equal(Boolean(response.isError), Boolean(expectedError));
  if (expectedError)
    assert.equal(response.structuredContent?.error?.code, expectedError);
  return response.structuredContent?.data;
}
const uid = (prefix) => `${prefix}_${randomUUID().replaceAll("-", "")}`;

try {
  const session = await fetch(`${base}/api/session`);
  cookie = session.headers.get("set-cookie")?.split(";", 1)[0];
  assert(cookie);
  csrf = (await session.json()).csrf;
  originalPermissions = (await ui("get_status", {})).permissions;
  await client.connect(transport);
  await ui("set_permissions", {
    permissions: {
      ...originalPermissions,
      append_notes: true,
      save_reviews: true,
      submit_courses: true,
      submit_knowledge: true,
      propose_relations: true,
    },
  });
  permissionsChanged = true;

  const noteArgs = {
    original_text: "MCP 演示环境协议测试记录。",
    type: "quick",
    client_request_id: uid("req"),
  };
  const note = await mcp("create_note", noteArgs);
  assert.match(note.id, /^note_/);
  const duplicate = await mcp("create_note", noteArgs);
  assert.equal(duplicate.id, note.id, "同一请求 ID 和内容须返回原记录");
  await mcp(
    "create_note",
    { ...noteArgs, original_text: "冲突内容" },
    "DUPLICATE_REQUEST_CONFLICT",
  );
  await mcp("get_note", { note_id: note.id }, "PERMISSION_DENIED");

  await ui("set_permissions", {
    permissions: {
      ...originalPermissions,
      append_notes: true,
      save_reviews: true,
      submit_courses: true,
      submit_knowledge: true,
      propose_relations: true,
      read_note_ids: [...originalPermissions.read_note_ids, note.id],
    },
  });
  const granted = await mcp("get_note", { note_id: note.id });
  assert.equal(granted.id, note.id);
  const review = await mcp("save_review_result", {
    note_ids: [note.id],
    body_md: "MCP 演示环境复盘测试。",
    client_request_id: uid("req"),
  });
  assert.match(review.id, /^review_/);

  const courses = await mcp("list_courses", {});
  assert(courses.items.length > 0, "演示库需要至少一门课程");
  const course = await mcp("get_course", { course_id: courses.items[0].id });
  assert(course.source_version_ids.length > 0);
  const excerpts = [];
  for (const sourceVersionId of course.source_version_ids) {
    let cursor;
    do {
      const page = await mcp("get_source_excerpt", {
        source_version_id: sourceVersionId,
        limit: 20,
        ...(cursor ? { cursor } : {}),
      });
      excerpts.push(...page.blocks);
      cursor = page.next_cursor;
    } while (cursor);
  }
  assert(excerpts.length > 0);
  const first = excerpts[0];
  const sourceRef = {
    source_document_id: first.source_document_id,
    source_version_id: first.source_version_id,
    source_block_id: first.id,
  };
  const topicId = uid("topic");
  const courseDraft = await mcp("submit_course_draft", {
    course_id: course.id,
    expected_revision: course.revision,
    overview: "MCP 演示环境草稿测试。",
    source_version_ids: course.source_version_ids,
    topics: [
      {
        id: topicId,
        course_id: course.id,
        parent_id: null,
        order: 0,
        title: "协议测试主题",
        content_kind: "teaching",
        blocks: [
          {
            id: uid("tb"),
            type: "summary",
            body_md: "协议测试讲义段。",
            origin_kind: "cleaned_transcript",
            transformation: "summary",
            source_refs: [sourceRef],
            verification_status: "needs_review",
          },
        ],
      },
    ],
    coverage: excerpts.map((block) => ({
      source_block_id: block.id,
      disposition: "included",
      topic_ids: [topicId],
    })),
    client_request_id: uid("req"),
  });
  assert.match(courseDraft.id, /^draft_/);
  const knowledgeDraft = await mcp("submit_knowledge_draft", {
    title: "MCP 协议测试知识草稿",
    type: "concept",
    body_md: "仅用于演示库测试。",
    source_refs: [sourceRef],
    expected_revision: 0,
    client_request_id: uid("req"),
  });
  assert.match(knowledgeDraft.id, /^draft_/);
  const relation = await mcp("propose_relations", {
    relations: [
      {
        from_id: note.id,
        to_id: course.id,
        kind: "related_to",
        reason: "演示环境协议测试。",
      },
    ],
    client_request_id: uid("req"),
  });
  assert.equal(relation.items.length, 1);
  const reviewRelation = await mcp("propose_relations", {
    relations: [
      {
        from_id: review.id,
        to_id: course.id,
        kind: "related_to",
        reason: "演示环境复盘关系测试。",
      },
    ],
    client_request_id: uid("req"),
  });
  assert.equal(reviewRelation.items.length, 1);
  await ui("set_permissions", {
    permissions: {
      ...originalPermissions,
      append_notes: true,
      save_reviews: true,
      submit_courses: true,
      submit_knowledge: true,
      propose_relations: true,
    },
  });
  const visibleRelations = await mcp("list_relations", {});
  assert.equal(
    visibleRelations.items.some(
      (item) => item.id === reviewRelation.items[0].id,
    ),
    false,
    "关联复盘未授权时不得公开关系",
  );
  await mcp(
    "propose_relations",
    {
      relations: [{ from_id: review.id, to_id: course.id, kind: "related_to" }],
      client_request_id: uid("req"),
    },
    "PERMISSION_DENIED",
  );
  await ui("set_permissions", {
    permissions: {
      ...originalPermissions,
      read_library: false,
      append_notes: true,
      save_reviews: true,
      submit_courses: true,
      submit_knowledge: true,
      propose_relations: true,
    },
  });
  const context = await mcp("get_agent_context", { sections: ["user"] });
  assert.deepEqual(
    context.available_materials,
    [],
    "资料读取被撤销后不能公开来源文件名",
  );
  process.stdout.write(
    "MCP demo writes and authorization boundaries: passed\n",
  );
} finally {
  if (permissionsChanged) {
    try {
      await ui("set_permissions", { permissions: originalPermissions });
      assert.deepEqual(
        (await ui("get_status", {})).permissions,
        originalPermissions,
      );
      process.stdout.write("Demo permissions restored\n");
    } catch (error) {
      process.stderr.write(
        `DEMO PERMISSIONS RESTORE FAILED: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    }
  }
  await client.close();
}
