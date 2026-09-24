import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = resolve(import.meta.dirname, "..");
const dataDir = await mkdtemp(join(tmpdir(), "learning-workbench-mcp-"));
let expectedToken = "test-token-1";
const seen = [];
const api = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  const parsed = JSON.parse(body);
  seen.push({ authorization: request.headers.authorization, ...parsed });
  response.setHeader("content-type", "application/json");
  response.end(
    JSON.stringify(
      request.headers.authorization === `Bearer ${expectedToken}`
        ? {
            ok: true,
            data: {
              app_version: "test",
              schema_version: 1,
              permissions: {},
              read_only: true,
              mode: "demo",
            },
            warnings: [],
            next_cursor: null,
          }
        : {
            ok: false,
            error: { code: "PERMISSION_DENIED", message: "凭据无效" },
            warnings: [],
            next_cursor: null,
          },
    ),
  );
});
await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
const address = api.address();
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(root, "dist/stdio.js")],
  cwd: root,
  env: {
    ...process.env,
    LEARNING_WORKBENCH_DATA_DIR: dataDir,
    LEARNING_WORKBENCH_URL: `http://127.0.0.1:${address.port}`,
  },
  stderr: "pipe",
});
const client = new Client({
  name: "learning-workbench-protocol-test",
  version: "1.0.0",
});
try {
  await writeFile(
    join(dataDir, "credentials.json"),
    JSON.stringify({ token: expectedToken }),
    { mode: 0o600 },
  );
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.equal(tools.length, 23);
  assert(tools.some((tool) => tool.name === "get_status"));
  assert(!tools.some((tool) => tool.name === "rotate_mcp_token"));
  const first = await client.callTool({ name: "get_status", arguments: {} });
  assert.equal(first.isError, false);
  assert.equal(first.structuredContent?.ok, true);
  assert.equal(seen.at(-1).authorization, "Bearer test-token-1");
  const invalid = await client.callTool({ name: "get_course", arguments: {} });
  assert.equal(invalid.isError, true);
  assert.equal(
    seen.length,
    1,
    "invalid inputs must not reach the business service",
  );
  expectedToken = "test-token-2";
  await writeFile(
    join(dataDir, "credentials.json"),
    JSON.stringify({ token: expectedToken }),
    { mode: 0o600 },
  );
  const second = await client.callTool({ name: "get_status", arguments: {} });
  assert.equal(second.isError, false);
  assert.equal(seen.at(-1).authorization, "Bearer test-token-2");
  assert.equal(seen.length, 2);
  await new Promise((resolve) => api.close(resolve));
  const offline = await client.callTool({ name: "get_status", arguments: {} });
  assert.equal(offline.isError, true);
  assert.equal(offline.structuredContent?.error?.code, "SERVICE_UNAVAILABLE");
  assert.match(offline.content[0].text, /SERVICE_UNAVAILABLE/);
  process.stdout.write(
    "MCP initialize, tools/list, validated tools/call, token rotation, offline error: passed\n",
  );
} finally {
  await client.close();
  api.close();
  await rm(dataDir, { recursive: true, force: true });
}
