import assert from "node:assert/strict";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startTestServer, session, project } from "./test-server.mjs";
const server = await startTestServer();
const client = new Client({ name: "habit-read-loop", version: "1.2.0" });
try {
  const ui = await session(server.base);
  const local = async (tool, args = {}) => {
    const r = await ui.rpc(tool, args);
    assert.equal(r.ok, true, JSON.stringify(r.error));
    return r.data;
  };
  const status = await local("get_status");
  const a = await local("create_note", {
    original_text: "合成协议回查 主记录",
    client_request_id: randomUUID(),
  });
  const b = await local("create_note", {
    original_text: "合成协议回查 次记录",
    client_request_id: randomUUID(),
  });
  const body = "合成协议回查 完整复盘 " + "保留复盘的条件与后续。".repeat(100);
  const review = await local("save_review_result", {
    note_ids: [a.id, b.id],
    body_md: body,
    client_request_id: randomUUID(),
  });
  const courses = await local("list_courses");
  const course = await local("get_course", { course_id: courses.items[0].id });
  const source = await local("get_source_excerpt", {
    source_version_id: course.source_version_ids[0],
    limit: 1,
  });
  const block = source.blocks[0];
  const ref = {
    source_document_id: block.source_document_id,
    source_version_id: block.source_version_id,
    source_block_id: block.id,
  };
  const description =
    "合成协议回查 完整案例 " + "原案例条件及细节。".repeat(100);
  const caseId = "case_mcp_habit";
  const pkg = {
    schema_version: "1.0.0",
    cases: [
      {
        id: caseId,
        description,
        source_identity: "Synthetic only",
        source_refs: [ref],
      },
    ],
  };
  const preview = await local("preview_import", {
    files: [
      {
        name: "habit-cases.json",
        content_base64: Buffer.from(JSON.stringify(pkg)).toString("base64"),
      },
    ],
  });
  await local("commit_import", { preview_id: preview.id });
  const permissions = {
    ...status.permissions,
    read_library: true,
    read_note_ids: [a.id, b.id],
  };
  await local("set_permissions", { permissions });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(project, "dist/stdio.js")],
      cwd: project,
      env: {
        ...process.env,
        LEARNING_WORKBENCH_URL: server.base,
        LEARNING_WORKBENCH_DATA_DIR: server.dir,
      },
      stderr: "pipe",
    }),
  );
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    assert.equal(
      r.isError,
      false,
      JSON.stringify(r.structuredContent ?? r.content),
    );
    return r.structuredContent.data;
  };
  const hits = await call("search_library", {
    query: "合成协议回查",
    types: ["case", "review"],
  });
  assert(hits.items.some((x) => x.id === review.id));
  assert(hits.items.some((x) => x.id === caseId));
  const fullReview = await call("get_review_result", { review_id: review.id });
  assert.equal(fullReview.body_md, body);
  for (const note_id of fullReview.note_ids)
    assert.equal((await call("get_note", { note_id })).id, note_id);
  const fullCase = await call("get_case", { case_id: caseId });
  assert.equal(fullCase.description, description);
  const actual = await call("get_source_excerpt", {
    source_version_id: fullCase.source_refs[0].source_version_id,
    source_block_id: fullCase.source_refs[0].source_block_id,
    limit: 1,
  });
  assert.equal(actual.blocks[0].text, block.text);
  await local("set_permissions", {
    permissions: { ...permissions, read_note_ids: [a.id] },
  });
  const denied = await client.callTool({
    name: "get_review_result",
    arguments: { review_id: review.id },
  });
  assert.equal(denied.isError, true);
  assert.equal(denied.structuredContent.error.code, "PERMISSION_DENIED");
  assert(
    !(
      await call("search_library", { query: "合成协议回查", types: ["review"] })
    ).items.some((x) => x.id === review.id),
  );
  await local("set_permissions", {
    permissions: { ...permissions, read_library: false },
  });
  assert.equal(
    (await call("get_review_result", { review_id: review.id })).body_md,
    body,
  );
  const caseDenied = await client.callTool({
    name: "get_case",
    arguments: { case_id: caseId },
  });
  assert.equal(caseDenied.isError, true);
  assert.equal(caseDenied.structuredContent.error.code, "PERMISSION_DENIED");
  console.log(
    "B08 passed: actual stdio search → full review/case → original notes/source; partial note revocation and library revocation enforced.",
  );
} finally {
  await client.close();
  await server.stop();
}
