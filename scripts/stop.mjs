import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
const dir =
  process.env.LEARNING_WORKBENCH_DATA_DIR ??
  join(homedir(), "Library", "Application Support", "LearningWorkbench");
const pidPath = join(dir, "server.pid");
if (!existsSync(pidPath)) {
  console.log("工作台未运行。");
  process.exit(0);
}
const pid = Number(readFileSync(pidPath, "utf8"));
try {
  const args = execFileSync("/bin/ps", ["-p", String(pid), "-o", "command="], {
    encoding: "utf8",
  });
  if (!/node .*dist\/index\.js|tsx .*src\/server\/index\.ts/.test(args))
    throw Error("PID已被其他进程使用，请勿强制停止。");
  process.kill(pid, "SIGTERM");
  console.log("已请求工作台安全停止。");
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
