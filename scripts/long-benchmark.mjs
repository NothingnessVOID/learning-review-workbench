import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startTestServer, session, project } from "./test-server.mjs";
const server = await startTestServer({ fixture: "long-fixture.ts" });
const results = [];
const client = new Client({ name: "long-shape-benchmark", version: "1.0.0" });
try {
  const ui = await session(server.base);
  const http = async (tool, args = {}) => {
    const begin = performance.now();
    const res = await ui.rpc(tool, args);
    const ms = performance.now() - begin;
    assert.equal(res.ok, true, JSON.stringify(res.error));
    results.push({
      channel: "HTTP",
      tool,
      ms: Number(ms.toFixed(2)),
      bytes: Buffer.byteLength(JSON.stringify(res)),
    });
    return res.data;
  };
  const courses = await http("list_courses", { limit: 20 });
  const course = await http("get_course", { course_id: courses.items[0].id });
  await http("get_topic", { topic_id: course.topics[0].id });
  await http("get_source_excerpt", {
    source_version_id: course.source_version_ids[0],
    limit: 20,
  });
  await http("list_knowledge", { limit: 50 });
  await http("list_notes", { limit: 50 });
  await http("search_library", { query: "工程合成", limit: 50 });
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
  for (const [name, args] of [
    ["list_knowledge", { limit: 50 }],
    ["list_notes", { limit: 50 }],
    ["search_library", { query: "工程合成", limit: 50 }],
    [
      "get_source_excerpt",
      { source_version_id: course.source_version_ids[0], limit: 20 },
    ],
  ]) {
    const begin = performance.now();
    const r = await client.callTool({ name, arguments: args });
    assert.equal(r.isError, false, JSON.stringify(r.structuredContent));
    results.push({
      channel: "MCP stdio",
      tool: name,
      ms: Number((performance.now() - begin).toFixed(2)),
      bytes: Buffer.byteLength(JSON.stringify(r)),
    });
  }
  const out = join(project, "artifacts/test-results");
  await mkdir(out, { recursive: true });
  await writeFile(
    join(out, "long-benchmark.json"),
    JSON.stringify(
      {
        runtime: process.version,
        platform: process.platform,
        fixture:
          "Synthetic: 3 long source versions; 300 long cards; 160 notes; 40 long reviews. No user materials.",
        results,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify(results, null, 2));
} finally {
  await client.close();
  await server.stop();
}
