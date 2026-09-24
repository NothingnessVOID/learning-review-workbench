# 第一版验收报告

2026-09-24；本机 macOS / Apple M4 / arm64，Node 26.0.0。仅下列实际运行的项目标为通过。正式库没有注入虚构的用户记录；测试与截图使用临时目录或独立 DEMO。

| 项目 | 结果 | 证据 |
|---|---|---|
| TypeScript 全项目检查与生产构建 | 通过 | artifacts/test-results/build.txt |
| 数据/安全集成用例 | 11/11 通过 | artifacts/test-results/unit.txt；tests/domain.test.ts、security.test.ts |
| MCP 官方 SDK initialize / tools/list / tools/call | 21 工具通过 | artifacts/test-results/mcp-protocol.txt |
| 真实服务状态、schema、上下文与学习层隔离 | 通过 | artifacts/test-results/mcp-live.txt |
| Codex CLI 实际 MCP get_status | 通过，临时配置 | docs/MCP_SETUP.md；CLI 0.155.0-alpha.16，无全局配置改动 |
| 演示库 MCP 追加、复盘、课程/卡片草稿、关联 | 通过 | scripts/mcp-demo-write-test.mjs；权限结束后恢复 |
| Host、Origin、会话、CSRF、Bearer 与 MCP 禁止操作 | 通过 | artifacts/test-results/http-security.txt |
| 浏览器课程→主题→原文→记录→反馈 | 通过 | docs/UI_TEST_REPORT.md、scripts/ui-test.mjs |
| 保存失败保留输入、同请求重试不重复 | 通过，真实浏览器模拟断网 | docs/UI_TEST_REPORT.md |
| 阅读位置恢复与重开页面 | 通过 | docs/UI_TEST_REPORT.md |
| 390 / 768 / 1280px 无横向溢出 | 通过 | artifacts/screenshots/ |
| 记录归档恢复、关联建议本地审核 | 通过 | docs/UI_TEST_REPORT.md |
| Markdown / TXT / JSON / ZIP 导入与去重 | 通过 | tests/domain.test.ts、security.test.ts |
| ZIP 越界、符号链接、体积异常拒绝 | 通过 | tests/security.test.ts |
| 同名新来源版本，旧引用仍打开旧文本 | 通过 | tests/domain.test.ts、security.test.ts |
| 覆盖遗漏与非法引用拒绝、并发草稿冲突 | 通过 | tests/domain.test.ts |
| 知识卡跨两个主题，资料更新保留用户层 | 通过 | tests/security.test.ts；DEMO 卡关联两门课 |
| 课程导出不夹带笔记；个人记录范围授权 | 通过 | tests/security.test.ts、domain.test.ts |
| 中文连续文本、两字词、别名、繁简体 | 通过 | tests/security.test.ts |
| 备份预览隔离、确认恢复、坏哈希拒绝 | 通过 | tests/domain.test.ts、security.test.ts |
| 服务重启后真实来源与草稿仍在 | 通过 | 本机启动/停止脚本实跑及数据库只读核对 |
| 100课程/2000卡/10000短记录性能 | 实测完成 | docs/PERFORMANCE.md，服务层延迟，不含浏览器/MCP网络开销 |

## 限制与尚未验证

- 用户点名的完整资料包未在本轮授权目录找到，尚未进行该真实资料包的字段映射和全量入库验收。通用入口已实现，未知 JSON 会报告未匹配，不静默跳过。
- 真实材料的内容质量仅做了小范围阅读与 AI 讲义草稿；没有逐段复听或事实核验。真实草稿的正式采用仍由用户处理。机器结构校验不代表语义正确。
- PDF/DOCX 原件识别为不支持导入，可单独提取成文本；本版没有内置适配器或 OCR。
- 源码备份恢复 schema=1 实测；跨 schema 自动迁移、远程 MCP、云端连接、其他客户端和其他操作系统尚未验证。
- 当前 Codex 桌面会话未自动热加载新 MCP；CLI 真实调用通过，永久配置需执行提供的安装命令。
- 键盘焦点与语义标签有实现；没有完成独立屏幕阅读器审计。
- 截图来自功能运行页面，不是设计效果图。工程 DEMO 不是用户真实课程或经历。
