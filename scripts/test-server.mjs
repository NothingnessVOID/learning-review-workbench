import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
export const project = resolve(
  process.env.TEST_PROJECT_ROOT ??
    fileURLToPath(new URL("..", import.meta.url)),
);
async function port() {
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const value = server.address().port;
  await new Promise((r) => server.close(r));
  return value;
}
async function run(args) {
  const child = spawn(process.execPath, args, {
    cwd: project,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (b) => (output += b));
  child.stderr.on("data", (b) => (output += b));
  const code = await new Promise((r, j) => {
    child.once("error", j);
    child.once("exit", r);
  });
  if (code !== 0) throw Error(output);
}
export async function startTestServer({ seed = true, fixture } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "workbench-e2e-"));
  const number = await port();
  const base = `http://127.0.0.1:${number}`;
  try {
    if (seed)
      await run([
        join(project, "node_modules/tsx/dist/cli.mjs"),
        join(project, "scripts/seed-demo.ts"),
        dir,
      ]);
    if (fixture)
      await run([
        join(project, "node_modules/tsx/dist/cli.mjs"),
        join(project, "scripts", fixture),
        dir,
      ]);
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
  const child = spawn(process.execPath, [join(project, "dist/index.js")], {
    cwd: project,
    env: {
      ...process.env,
      LEARNING_WORKBENCH_DATA_DIR: dir,
      LEARNING_WORKBENCH_PORT: String(number),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (b) => (output = (output + b).slice(-10000)));
  child.stderr.on("data", (b) => (output = (output + b).slice(-10000)));
  let exited = false;
  child.once("exit", () => (exited = true));
  const stop = async () => {
    if (!exited) {
      child.kill("SIGTERM");
      await Promise.race([
        new Promise((r) => child.once("exit", r)),
        new Promise((r) => setTimeout(r, 5000).unref()),
      ]);
      if (!exited) child.kill("SIGKILL");
    }
    await rm(dir, { recursive: true, force: true });
  };
  try {
    for (let i = 0; i < 300; i++) {
      if (exited) throw Error(output);
      try {
        const h = await (
          await fetch(base + "/health", { signal: AbortSignal.timeout(1000) })
        ).json();
        if (h.app === "learning-workbench") {
          const token = JSON.parse(
            await readFile(join(dir, "credentials.json"), "utf8"),
          ).token;
          return { base, dir, port: number, token, stop, output: () => output };
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    throw Error("Test server failed: " + output);
  } catch (e) {
    await stop();
    throw e;
  }
}
export async function session(base) {
  const response = await fetch(base + "/api/session");
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  const { csrf } = await response.json();
  return {
    cookie,
    csrf,
    async rpc(tool, args = {}) {
      const r = await fetch(base + "/api/rpc", {
        method: "POST",
        headers: {
          cookie,
          "x-csrf-token": csrf,
          "content-type": "application/json",
        },
        body: JSON.stringify({ tool, args }),
      });
      return r.json();
    },
  };
}
