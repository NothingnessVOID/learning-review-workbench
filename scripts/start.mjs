import { existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const demo = process.argv.includes("--demo");
const port = demo ? 47832 : 47831;
const dir = demo
  ? join(root, ".data", "demo")
  : join(homedir(), "Library", "Application Support", "LearningWorkbench");
if (Number(process.versions.node.split(".")[0]) < 24) {
  console.error("需要 Node.js 24 或更高版本。请安装后重新运行。");
  process.exit(1);
}
const address = `http://127.0.0.1:${port}`;
async function health() {
  try {
    const r = await fetch(address + "/health", {
      signal: AbortSignal.timeout(1000),
    });
    const d = await r.json();
    return d.app === "learning-workbench";
  } catch {
    return false;
  }
}
if (await health()) {
  console.log("工作台已运行，正在打开。");
  if (process.platform === "darwin") spawnSync("/usr/bin/open", [address]);
  process.exit(0);
}
const npm = join(process.execPath, "..", "npm");
if (!existsSync(join(root, "node_modules"))) {
  console.log("首次启动：正在安装锁定版本依赖。");
  const install = spawnSync(npm, ["ci"], { cwd: root, stdio: "inherit" });
  if (install.status !== 0) process.exit(install.status ?? 1);
}
if (
  !existsSync(join(root, "dist", "index.js")) ||
  !existsSync(join(root, "dist", "web", "index.html"))
) {
  console.log("首次启动：正在构建应用。");
  const build = spawnSync(npm, ["run", "build"], {
    cwd: root,
    stdio: "inherit",
  });
  if (build.status !== 0) process.exit(build.status ?? 1);
}
if (demo && !existsSync(join(dir, "workbench.sqlite"))) {
  const seed = spawnSync(
    process.execPath,
    [
      join(root, "node_modules", "tsx", "dist", "cli.mjs"),
      join(root, "scripts", "seed-demo.ts"),
      dir,
    ],
    { cwd: root, stdio: "inherit" },
  );
  if (seed.status !== 0) process.exit(seed.status ?? 1);
}
mkdirSync(dir, { recursive: true, mode: 0o700 });
const log = openSync(join(dir, "server.log"), "a", 0o600);
const child = spawn(process.execPath, [join(root, "dist", "index.js")], {
  cwd: root,
  env: {
    ...process.env,
    LEARNING_WORKBENCH_DATA_DIR: dir,
    LEARNING_WORKBENCH_PORT: String(port),
  },
  detached: true,
  stdio: ["ignore", log, log],
});
child.unref();
let ready = false;
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 150));
  if (await health()) {
    ready = true;
    break;
  }
}
if (!ready) {
  console.error(
    `未能启动。请查看 ${join(dir, "server.log")}。端口可能被其他程序占用。`,
  );
  process.exit(1);
}
console.log(
  `已启动：${address}\n数据目录：${dir}\n停止时运行“停止工作台.command”。`,
);
if (process.platform === "darwin") spawnSync("/usr/bin/open", [address]);
