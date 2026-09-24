import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { sharedToolSchemas } from "../src/domain/contracts.js";
import { Service } from "../src/domain/service.js";

const root = process.cwd();
const tsx = join(root, "node_modules/tsx/dist/cli.mjs");
async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

test("M02: service, HTTP, and official MCP SDK enforce the same strict read inputs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "learning-workbench-contract-"));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [tsx, "src/server/index.ts"], {
    cwd: root,
    env: {
      ...process.env,
      LEARNING_WORKBENCH_DATA_DIR: dir,
      LEARNING_WORKBENCH_PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-1000);
  });
  const client = new Client({
    name: "read-contract-regression",
    version: "1.0.0",
  });
  try {
    let ready = false;
    for (let i = 0; i < 300; i++) {
      try {
        const health = await (
          await fetch(base + "/health", { signal: AbortSignal.timeout(1000) })
        ).json();
        if (health.app === "learning-workbench") {
          ready = true;
          break;
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert(ready, `temporary server failed: ${stderr}`);
    const local = new Service(dir, root);
    try {
      const invalid = { unexpected: true };
      for (const [tool, schema] of Object.entries(sharedToolSchemas)) {
        assert.equal(
          schema.safeParse(invalid).success,
          false,
          `${tool} schema must reject unknown fields`,
        );
        assert.equal(
          (await local.invoke(tool, invalid)).error?.code,
          "VALIDATION_ERROR",
          `${tool} must use the shared schema`,
        );
      }
      const session = await fetch(base + "/api/session");
      const cookie = session.headers.get("set-cookie")?.split(";")[0];
      const { csrf } = await session.json();
      const uiResponse = await fetch(base + "/api/rpc", {
        method: "POST",
        headers: {
          cookie: cookie!,
          "x-csrf-token": csrf,
          "content-type": "application/json",
        },
        body: JSON.stringify({ tool: "get_status", args: invalid }),
      });
      assert.equal((await uiResponse.json()).error?.code, "VALIDATION_ERROR");
      const token = JSON.parse(
        readFileSync(join(dir, "credentials.json"), "utf8"),
      ).token;
      const httpMcp = await fetch(base + "/api/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ tool: "get_status", args: invalid }),
      });
      assert.equal((await httpMcp.json()).error?.code, "VALIDATION_ERROR");
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [tsx, "src/mcp/stdio.ts"],
          cwd: root,
          env: {
            ...process.env,
            LEARNING_WORKBENCH_DATA_DIR: dir,
            LEARNING_WORKBENCH_URL: base,
          },
          stderr: "pipe",
        }),
      );
      const registered = await client.listTools();
      assert.deepEqual(
        new Set(registered.tools.map((tool) => tool.name)),
        new Set(Object.keys(sharedToolSchemas)),
      );
      const invalidMcp = await client.callTool({
        name: "get_status",
        arguments: invalid,
      });
      assert.equal(invalidMcp.isError, true);
      const validMcp = await client.callTool({
        name: "get_status",
        arguments: {},
      });
      assert.equal(validMcp.isError, false);
      assert.equal((validMcp.structuredContent as any)?.ok, true);
    } finally {
      local.store.close();
    }
  } finally {
    await client.close();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      await Promise.race([
        exited,
        new Promise((resolve) => setTimeout(resolve, 5000).unref()),
      ]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await exited;
      }
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("M02: shared pagination defaults are explicit and reject boolean coercion", () => {
  const defaults = sharedToolSchemas.list_notes.parse({});
  assert.equal(defaults.limit, 30);
  assert.equal(defaults.cursor, 0);
  assert.equal(
    sharedToolSchemas.get_source_excerpt.parse({ source_version_id: "sv_demo" })
      .limit,
    3,
  );
  assert.equal(sharedToolSchemas.list_notes.parse({ cursor: "40" }).cursor, 40);
  for (const bad of [
    { limit: true },
    { cursor: false },
    { cursor: "not-a-number" },
    { limit: 101 },
  ])
    assert.equal(sharedToolSchemas.list_notes.safeParse(bad).success, false);
});
