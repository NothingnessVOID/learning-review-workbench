# 实施决策

2026-09-24。在已授权目录新建独立项目，普通技术选择由开发者推进。本项目不移动原资料，也不沿用其他工作区的软件。

1. React 19 + TypeScript + Vite，Express 本地 HTTP，Node 内置 SQLite。使用当前机器 Node 26.0.0 arm64；Node SQLite 仍有 release-candidate 状态，版本升级需要构建与数据恢复回归。选择内置 SQLite 避免本机原生扩展编译，不采用云库。
2. 主数据在 `~/Library/Application Support/LearningWorkbench`，开发 DEMO 在 `.data/demo`。资料对象分表存储；对象字段保存在每行 JSON 中，ID、版本、时间、父对象、搜索索引为独立列，避免全库大 JSON。
3. 同一业务服务串行处理写入和备份；所有写入成功发生在 SQLite 提交之后。来源快照先写入再建立引用；失败时可能留下未被引用的哈希文件，但不会产生指向缺失文件的正式引用。
4. 用独立 DEMO 验证功能，真实来源只在本机授权范围内处理；私人盘点、原始需求及衍生讲义不随 Git 上传。
5. 原始导入只做确定性分段。高质量讲义使用外部 Agent 生成的草稿，完整覆盖表区分主线和保留上下文，用户在网页采用。
6. MCP 官方 TypeScript SDK stdio 作为薄 HTTP 适配器；默认仅资料读取，写能力分开授权，笔记按 ID 授权。正式采用和恢复仅本地会话可执行。没有公开端口、隧道或遥测。
7. 搜索采用 OpenCC 繁简转换、指定别名和 SQLite instr 子串匹配。两字词可检索；当前无需向量数据库。性能规模与实际测量见 PERFORMANCE.md。
8. 备份使用 Node sqlite.backup 在线一致性快照，恢复检查清单/哈希/库结构/引用后切换。应用层未加密，不宣传为加密库。
9. UI 以浅色纸面、墨绿、正文宽度与行距为主，没有外部字体或图片资源。

技术核对来源：
- Node SQLite API：https://nodejs.org/api/sqlite.html
- SQLite Online Backup：https://www.sqlite.org/backup.html
- OpenCC JS：https://github.com/nk2028/opencc-js
- MCP / Codex 实测及版本详见 MCP_SETUP.md 和 DEPENDENCIES.md。
