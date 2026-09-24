# 交接与进度

第一版本地实现及核心验收完成。仓库只含软件、通用上下文、独立 DEMO、schema、模板与测试；私人材料与配置在 .gitignore 中明确排除。

## 已完成

- React 中文三入口，课程地图/讲义、原文前后文、卡片、记录与复盘时间线、搜索与续读。
- 本地 SQLite 主库、不可变哈希来源、个人层隔离、幂等、冲突检测、修订与审计。
- Markdown/TXT/JSON/ZIP 预览导入，结构化草稿人工审核/拒绝/撤回，建议关联审核。
- 官方 SDK stdio MCP 21 工具，按能力与个人记录 ID 控制访问，真实 Codex CLI 调用。
- 完整备份恢复、选定范围导出/分享预览、一键启动/停止、独立演示。
- 11 项数据与安全测试、浏览器链路和响应式截图、协议/HTTP边界测试及性能基准。

## 下一步需要实际材料或用户判断

1. 用户审阅本机真实课程讲义草稿与知识候选；不由开发脚本自动采用。
2. 获取待提供课程资料包，先预览再作具体字段映射；不把通用 JSON 支持宣称为该包全量兼容。
3. 如需在日常 Codex 持久连接，运行 scripts/install-mcp.mjs 查看差异，再自行加 --apply；默认不扩大私人记录权限。
4. 可基于 REVIEW_GUIDE.md 对代码安全、持久化、恢复及导入边界进行独立审查。

## 恢复工作

先读 AGENTS.md → PROJECT_REQUIREMENTS.md → DATA_SCHEMA.md → TEST_REPORT.md。本地特定资料情况另有被 Git 忽略的文件，不在共享仓库中。开发用 npm run build / npm test；DEMO 用 scripts/seed-demo.ts 和端口47832。不要在真实库创建测试笔记。

已知产品边界详见 TEST_REPORT.md。Node 内置 SQLite 当前运行时为26.0.0；平台升级后需要重新跑恢复和MCP测试。远程部署、同步、内置模型和完整方法 Skill 不属于此版。
