import { existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  root,
  fingerprints,
  readBuild,
  isCurrentBuild,
} from "./build-info.mjs";
const demo = process.argv.includes("--demo");
const update = process.argv.includes("--update");
const port = demo ? 47832 : 47831;
const dir = demo
  ? join(root, ".data", "demo")
  : join(homedir(), "Library", "Application Support", "LearningWorkbench");
const address = `http://127.0.0.1:${port}`;
function fail(message) {
  console.error(message);
  process.exit(1);
}
if (Number(process.versions.node.split(".")[0]) < 24)
  fail("需要 Node.js 24 或更高版本。请安装后重新运行。");
async function health() {
  try {
    const r = await fetch(address + "/health", {
      signal: AbortSignal.timeout(1000),
    });
    const value = await r.json();
    if (value.app !== "learning-workbench")
      fail(`端口 ${port} 上运行着其他程序；未停止该程序。`);
    return value;
  } catch {
    return null;
  }
}
function open() {
  if (process.platform === "darwin" && !process.argv.includes("--no-open"))
    spawnSync("/usr/bin/open", [address]);
}
const current = fingerprints();
let built = readBuild();
const running = await health();
if (running && isCurrentBuild(running.build, current)) {
  console.log(
    `工作台已运行：${running.build.version} · ${running.build.fingerprint.slice(0, 12)}`,
  );
  open();
  process.exit(0);
}
if (running) {
  if (!update)
    fail(
      "发现正在运行的旧版本。资料仍保留；请双击“更新并启动工作台.command”，或运行 node scripts/start.mjs --update。演示库另加 --demo。",
    );
  const pidFile = join(dir, "server.pid");
  if (!existsSync(pidFile))
    fail("缺少本实例 PID，无法安全更新。请关闭此工作台后重试。");
  const pid = Number(readFileSync(pidFile, "utf8"));
  let command;
  try {
    command = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
    }).trim();
  } catch {
    fail("无法确认现有工作台进程，未停止任何进程。");
  }
  if (!command.endsWith(join(root, "dist", "index.js")))
    fail("现有 PID 不属于本项目构建，未停止任何进程。");
  process.kill(pid, "SIGTERM");
  for (let i = 0; i < 100 && (await health()); i++)
    await new Promise((r) => setTimeout(r, 100));
  if (await health()) fail("工作台仍在收尾，请稍后重新运行更新。");
}
const npm = join(
  process.execPath,
  "..",
  process.platform === "win32" ? "npm.cmd" : "npm",
);
const dependencyStamp = join(root, "node_modules", ".workbench-lock");
if (
  !existsSync(dependencyStamp) ||
  readFileSync(dependencyStamp, "utf8").trim() !== current.lock_hash
) {
  console.log("依赖锁文件已变更或尚未验证，安装锁定版本；不升级依赖版本。");
  const install = spawnSync(npm, ["ci"], { cwd: root, stdio: "inherit" });
  if (install.status !== 0)
    fail("锁定依赖安装失败；资料未修改。请检查网络后重试。");
}
if (
  !isCurrentBuild(built, current) ||
  !existsSync(join(root, "dist", "index.js")) ||
  !existsSync(join(root, "dist", "web", "index.html"))
) {
  console.log("源码或依赖已更新，正在重新构建。");
  const build = spawnSync(npm, ["run", "build"], {
    cwd: root,
    stdio: "inherit",
  });
  if (build.status !== 0) fail("构建失败，未启动旧版本；资料未修改。");
  built = readBuild();
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
  if (seed.status !== 0) fail("演示资料初始化失败。");
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
let ready = null;
for (let i = 0; i < 50; i++) {
  await new Promise((r) => setTimeout(r, 150));
  ready = await health();
  if (ready) break;
}
if (!ready || !isCurrentBuild(ready.build, fingerprints()))
  fail(`未能启动当前构建。请查看 ${join(dir, "server.log")}，检查端口占用。`);
console.log(
  `已启动：${address}\n版本：${ready.build.version} · ${ready.build.fingerprint.slice(0, 12)}\n数据目录：${dir}`,
);
open();
