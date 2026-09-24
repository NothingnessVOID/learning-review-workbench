#!/usr/bin/env node
import { copyFile, readFile, stat, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
if (args.some((arg) => !["--apply", "--help", "-h"].includes(arg))) {
  process.stderr.write("用法：node scripts/install-mcp.mjs [--apply]\n");
  process.exit(2);
}
if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write(
    "默认只预览 Codex MCP 配置差异。仅在明确传入 --apply 时备份已有 config.toml 并调用 codex mcp add。\n",
  );
  process.exit(0);
}

const projectDir = resolve(import.meta.dirname, "..");
const entry = join(projectDir, "dist/stdio.js");
const node = resolve(process.execPath);
const codexHome = resolve(process.env.CODEX_HOME ?? join(homedir(), ".codex"));
const config = join(codexHome, "config.toml");
let original = "";
try {
  original = await readFile(config, "utf8");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const existing = /^\[mcp_servers\.learning_workbench(?:\.[^\]]+)?\]\s*$/m.test(
  original,
);
process.stdout.write(`Codex 配置：${config}\n`);
if (existing) {
  process.stdout.write(
    "差异：0 行。learning_workbench 已存在；脚本不会覆盖现有条目或输出其中可能含有的凭据。\n",
  );
  process.exit(0);
}
const tomlString = (value) => JSON.stringify(value);
process.stdout.write("将新增以下等价 TOML 配置：\n");
process.stdout.write(
  `+[mcp_servers.learning_workbench]\n+command = ${tomlString(node)}\n+args = [${tomlString(entry)}]\n`,
);
process.stdout.write(
  "现有其他配置保持原样。凭据从工作台数据目录读取，不写入 Codex 配置。\n",
);
if (!apply) {
  process.stdout.write("这是预览；用户运行同一脚本并加 --apply 才会安装。\n");
  process.exit(0);
}

await stat(entry);
const nodeStat = await stat(node);
if (!nodeStat.isFile()) throw new Error("Node 运行时路径不是文件");
const codex = spawnSync("codex", ["mcp", "add", "--help"], {
  encoding: "utf8",
  stdio: "ignore",
});
if (codex.error || codex.status !== 0)
  throw new Error("未找到可用的 codex mcp add 命令");
if (original) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${config}.backup-${stamp}`;
  await copyFile(config, backup);
  await chmod(backup, 0o600);
  process.stdout.write(`已备份：${backup}\n`);
}
const installed = spawnSync(
  "codex",
  ["mcp", "add", "learning_workbench", "--", node, entry],
  { encoding: "utf8", stdio: "pipe" },
);
if (installed.error || installed.status !== 0) {
  process.stderr.write("Codex MCP 添加失败；原配置备份仍在。\n");
  process.exit(1);
}
process.stdout.write(
  "learning_workbench 已添加。可用 codex mcp get learning_workbench 核对。\n",
);
