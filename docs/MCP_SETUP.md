# 本机 MCP 连接

工作台使用官方 `@modelcontextprotocol/sdk` 提供 stdio MCP 服务。适配器只向本机业务服务 `http://127.0.0.1:47831/api/mcp` 转发请求，不另建数据副本。服务必须先运行；在项目目录执行 `npm run build`，然后执行 `npm start`。网页地址是 `http://127.0.0.1:47831`。

验证环境为 Codex CLI `0.155.0-alpha.16`、Node 26。下列为可分享结构示例，运行安装脚本会生成你机器上的实际绝对路径。本机实际配置片段保留在被 Git 忽略的 docs/LOCAL_MCP_SETUP.md。把下面片段**追加**到 Codex 配置文件即可；此项目没有自行更改全局配置。加入前先备份已有配置。

可先运行 `node scripts/install-mcp.mjs` 查看当前配置的精确新增条目；默认只预览。只有你自行运行 `node scripts/install-mcp.mjs --apply` 时，脚本才会备份已有 `config.toml` 并调用本机 `codex mcp add`。已有同名条目时脚本保持原配置，不覆盖。

```toml
[mcp_servers.learning_workbench]
command = "/ABSOLUTE/PATH/TO/node"
args = ["/ABSOLUTE/PATH/TO/PROJECT/dist/stdio.js"]
cwd = "/ABSOLUTE/PATH/TO/PROJECT"
```

适配器每次工具调用都从 `~/Library/Application Support/LearningWorkbench/credentials.json` 读取 MCP token，网页轮换 token 后无需重启适配器。若工作台使用自定义数据目录，在上述表中加 `env = { LEARNING_WORKBENCH_DATA_DIR = "/绝对路径/数据目录" }`。该目录的 `credentials.json` 应由工作台创建，不要将 token 写入配置或项目。`LEARNING_WORKBENCH_URL` 仅用于覆盖本地服务地址，只接受 `http://127.0.0.1:端口`，不接受远程主机。适配器 stdout 只用于 MCP 协议。

读取工具：`get_status`、`get_agent_context`、`get_schema`、`list_courses`、`get_course`、`get_topic`、`list_knowledge`、`get_knowledge_card`、`get_source_excerpt`、`search_library`、`list_notes`、`get_note`、`get_case`、`get_review_result`、`list_drafts`、`get_draft_status`、`list_audit`、`list_relations`。写入工具：`create_note`、`save_review_result`、`propose_relations`、`submit_course_draft`、`submit_knowledge_draft`。网页专用的审核、权限、备份和导入工具不通过 MCP 暴露。个人记录读取及每类写入权限由本地服务检查；适配器的工具标注仅帮助客户端识别风险。

在项目目录运行 `node scripts/mcp-protocol-test.mjs` 可用官方 SDK 客户端验证 initialize、tools/list、tools/call、输入校验、凭据轮换和服务离线错误；测试使用临时模拟服务与临时 token，不读取真实数据。服务运行后可运行 `node scripts/mcp-live-check.mjs`，它仅调用 `get_status`、`get_schema(note)`、`get_agent_context(user)`，只输出成功状态，不打印正文。构建产物位于 `dist/stdio.js`。本地服务未启动时，工具返回 `SERVICE_UNAVAILABLE` 和中文启动说明。

本机 Codex 命令支持 `codex mcp list` 和 `codex exec -c key=value`。可先用临时配置验证发现情况，避免修改已有配置：

```sh
codex mcp list -c 'mcp_servers.learning_workbench={command="/ABSOLUTE/PATH/TO/node",args=["/ABSOLUTE/PATH/TO/PROJECT/dist/stdio.js"],cwd="/ABSOLUTE/PATH/TO/PROJECT"}'
```

2026-09-24 本机联调：官方 SDK 客户端对真实服务完成 `tools/list`（21 项）、`get_status`、`get_schema(note)` 和 `get_agent_context(user)`，均成功。Codex CLI `0.155.0-alpha.16` 使用 `--ignore-user-config` 与临时 `-c mcp_servers.learning_workbench=...` 实际调用 `get_status` 一次，返回 `app_version: 1.0.0`、`schema_version: 1.0.0`；没有修改全局配置。云端 Agent 的 `localhost` 不指向这台电脑，不能自动连接本地工作台。首版不提供公网 MCP 端点。

独立演示库写入联调在 `127.0.0.1:47832` 与项目 `.data/demo` 完成：SDK 客户端验证记录追加、相同请求幂等、不同内容冲突、按条授权读取、复盘保存、课程草稿、知识草稿和待确认关联。测试结束已恢复演示库原有权限。复现时必须明确设置 `LEARNING_WORKBENCH_URL=http://127.0.0.1:47832` 和 `LEARNING_WORKBENCH_DATA_DIR` 指向该项目的 `.data/demo`；`scripts/mcp-demo-write-test.mjs` 会拒绝在其他目录或端口写入。

`scripts/http-security-test.mjs` 使用相同的演示库限制检查 HTTP Host/Origin、会话与 CSRF、MCP 凭据、网页专用操作拒绝，以及个人学习状态和来源文件名的授权边界。脚本临时修改演示库权限后会恢复原值并复核；它不用于真实资料库。

v1.1：工具输入由 `src/domain/contracts.ts` 同时供本地服务和 MCP 校验。列表新增分页并默认返回摘要，完整正文通过详情取得；复盘和案例加入搜索。个人记录关联结果会随授权撤销而过滤。单次读取超过 2 MiB 时明确报错，需缩小列表范围或分段读取原文。

v1.1 时 stdio 接口为 21 项；v1.2 已增加两个受限详情读取入口，当前共 23 项。网页交接包与备份上下文选项仍为本地网页功能，没有扩张 MCP 写权限。客户端的其他文件或命令权限不受本工作台 MCP 勾选框约束；授权给外部模型的返回内容可能离开本机。

## v1.2 更新

当前提供 **23 项工具**，新增 `get_case` 和 `get_review_result` 两个只读入口。实际 stdio 的“搜索 → 完整复盘/案例 → 原始记录/来源”链路由 `npm run test:habit-mcp` 在临时服务中验证；撤销任一源记录权限后不能继续读取整篇复盘，撤销资料库权限后案例读取被拒绝。写权限没有扩大。

日期筛选需要本地日时，请发送带时区的起点 `from` 与下一日开始 `to_exclusive`，而非无时区日历字符串。完整合同见 `API_CONTRACT.md`。工作台方法资料不完整与接收 Agent 的实际 Skill 能力分开表述，执行端需自行核验自己的能力。
