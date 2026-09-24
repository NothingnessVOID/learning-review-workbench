# 个人学习与复盘工作台

本地中文学习应用，含课程阅读、知识卡、随手记录、来源定位、草稿审核与真实 stdio MCP。资料保存到 SQLite 和不可变来源快照，运行时无需模型 API、云服务或网络字体。

## 打开

双击 **启动学习工作台.command**，浏览器打开 http://127.0.0.1:47831 。重复打开会复用已有服务。首次运行若依赖或构建不存在，会按 package-lock.json 安装与构建；需要 Node.js 24+ 和首次安装时的网络。

双击 **打开独立演示.command** 可尝试已经贯通的演示课程、跨课程卡片、记录时间线及草稿审核，地址 http://127.0.0.1:47832 。演示内容为虚构，与私人库分开。

双击 **停止工作台.command** 安全停止私人库服务。它不会删除数据。停止独立演示：`LEARNING_WORKBENCH_DATA_DIR="$PWD/.data/demo" node scripts/stop.mjs`。

## 开始使用

1. 进入课程，选择主题阅读，通过“查看出处”核对保存版本中的真实段落。
2. 点击“记一句”。只需正文，关联自动带入，也可移除。保存失败时保留本机草稿供重试。
3. 在“我的记录”查看原始输入、外部复盘和后续反馈。学习状态由自己标记。
4. 导入先预览再确认。Markdown/TXT 建立来源和原文目录；结构化 JSON 进入整理草稿。网页不会自行调用模型。
5. 在待审草稿里核对新旧内容和引用，决定采用、拒绝或撤回。
6. 连接 Agent 前在“设置与备份”分别授权能力。默认只允许资料读取，不允许读私人记录或写入；私人记录按条选择。

本仓库只包含软件和独立 DEMO。用户原始需求、个人上下文、课程原件、实际导入报告和私人数据库保留在本机，不随仓库上传。通用软件需求见 docs/PROJECT_REQUIREMENTS.md；代码审查入口见 docs/REVIEW_GUIDE.md。

## 数据与备份

私人数据：`~/Library/Application Support/LearningWorkbench/`。源码与数据库分离，升级代码不会覆盖数据。演示数据：项目 `.data/demo/`。业务数据不依赖浏览器缓存；只有未提交的文字和阅读字号暂存在浏览器本地。

设置页可导出全部或选定课程、卡片、笔记。课程导出不夹带私人记录。分享版可指定脱敏词并预览。完整备份使用 SQLite 在线快照，包含来源文件和 SHA-256 清单；恢复先校验，在本地输入确认文字后切换，并保留恢复前备份。

数据与备份未做应用层加密。不要将含私人内容的目录公开或上传。MCP 返回给外部客户端的已授权内容可能进入该客户端的模型上下文。

## MCP

实际官方 SDK stdio 服务与本机 Codex CLI 已完成工具发现和调用。连接配置与权限见 [docs/MCP_SETUP.md](docs/MCP_SETUP.md)。提供安装配置预览脚本，默认不会更改现有 Codex 配置。全局现有配置未自动改动。

## 开发和验证

```sh
npm ci
npm run build
npm test
node scripts/mcp-protocol-test.mjs
npm start
```

详细交付边界、测试、来源与后续工作：

- docs/TEST_REPORT.md、docs/PERFORMANCE.md、docs/PROGRESS.md
- docs/PROJECT_REQUIREMENTS.md、docs/REVIEW_GUIDE.md
- docs/DATA_SCHEMA.md、docs/BACKUP_RESTORE.md、docs/PRIVACY.md
- schemas/ 与 prompts/：外部 Agent 的格式和处理约定

## 常见问题

- 服务未开：双击启动文件。MCP 会返回 SERVICE_UNAVAILABLE，不另建空库。
- 端口占用：若 /health 是本工作台可直接打开；若是其他服务需先处理占用，不能启动第二个写入服务。
- Node 路径变化：启动文件先试本机路径，再找 PATH。可用当前 Node 执行 `node scripts/start.mjs`。
- 保存失败：不要关闭仍有输入的页面，可复制或重试；先恢复本地服务。
- 数据目录找不到或锁定：检查目录权限和磁盘空间，退出重复进程；不要手工删 SQLite 的 WAL/SHM 文件。
- 云端 Agent：不能直接访问本机 localhost，首版使用选择导出/导入，不提供公网隧道。
