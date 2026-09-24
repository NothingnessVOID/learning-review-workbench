# v1.2 第二轮验收

当前第二轮复审结果、B01–B09 对照、测试命令及实际数据样本范围统一记录在 [SECOND_REVIEW.md](SECOND_REVIEW.md)。以下为第一轮历史验收；其中未覆盖的跨模块问题已经在第二轮补充，不将原有通过数量扩大为新场景通过。

---

# v1.1 验收报告

2026-09-24，macOS arm64 / Node 26。针对独立审查的 29 项问题完成代码改进；逐项见 [改进跟踪](IMPROVEMENT_TRACKER.md)。以下是本机实际执行结果，GitHub Actions 的当前结果以仓库运行页面为准。

| 检查                                         | 结果                               | 证据                                                       |
| -------------------------------------------- | ---------------------------------- | ---------------------------------------------------------- |
| TypeScript 与前后端生产构建                  | 通过                               | artifacts/test-results/build-v1.1.txt                      |
| 数据、恢复、权限、输入合同、上下文与竞争回归 | 45/45 通过                         | artifacts/test-results/unit-v1.1.txt                       |
| 真实 HTTP 两个独立实例                       | 通过                               | artifacts/test-results/http-v1.1.txt                       |
| 官方 SDK stdio 协议与 21 工具                | 通过                               | artifacts/test-results/mcp-v1.1.txt                        |
| 两套完整浏览器流程                           | 通过                               | artifacts/test-results/ui-v1.1.txt；UI_TEST_REPORT.md      |
| 长正文与来源版本 HTTP / MCP 实测             | 完成                               | artifacts/test-results/long-benchmark.json；PERFORMANCE.md |
| 正式库升级前备份在临时目录恢复               | 通过：SQLite 完整性及来源哈希一致  | 私人验收记录不提交仓库                                     |
| 两份旧版待审核草稿兼容性                     | 在临时副本可采用，正式库保持待审核 | 私人验收记录不提交仓库                                     |

备份测试覆盖容量边界、当前来源损坏/缺失、staging 篡改重验、恢复失败回滚和可选上下文；导入测试覆盖失败清理与同包依赖；权限测试覆盖多条记录组成的复盘、关系和交接内容。共用输入合同由 Service、HTTP、官方 MCP SDK 实测，非法字段与无效日期被拒绝。读取返回超过 2 MiB 会明确报错，不静默截断内容。

所有会写入记录、审核草稿或制造损坏的工程测试都在临时 DEMO 数据目录完成。真实库没有新增虚构笔记，也没有自动采用真实草稿。

## 仍需真实材料或用户操作

- T19：尚未取得待适配的实际既有资料包。本轮验证通用临时 ID 映射与课程/卡片依赖，不能据此宣称该真实资料包全量兼容。
- T30：用户本人完成四条日常工作流的可用性验收尚未进行。工程浏览器操作不能代替用户本人体验。
- 超过 30 门课程/知识卡的前端视觉路径未单独实测；共同分页组件的记录、搜索、权限与导出路径已用 160 条数据实测，课程/知识列表的服务层分页有覆盖。
- 没有独立屏幕阅读器审计；键盘焦点和背景隔离已由浏览器测试覆盖。
- 没有远程部署、手机连本机、ChatGPT 网页直接连本地 MCP、跨 schema 自动迁移或完整方法 Skill 的验收。公开仓库用于审查代码，本机私人资料不随仓库公开。

---

# v1.0 历史验收报告

2026-09-24；本机 macOS / Apple M4 / arm64，Node 26.0.0。仅下列实际运行的项目标为通过。正式库没有注入虚构的用户记录；测试与截图使用临时目录或独立 DEMO。

| 项目                                              | 结果                     | 证据                                                                    |
| ------------------------------------------------- | ------------------------ | ----------------------------------------------------------------------- |
| TypeScript 全项目检查与生产构建                   | 通过                     | artifacts/test-results/build.txt                                        |
| 数据/安全集成用例                                 | 11/11 通过               | artifacts/test-results/unit.txt；tests/domain.test.ts、security.test.ts |
| MCP 官方 SDK initialize / tools/list / tools/call | 21 工具通过              | artifacts/test-results/mcp-protocol.txt                                 |
| 真实服务状态、schema、上下文与学习层隔离          | 通过                     | artifacts/test-results/mcp-live.txt                                     |
| Codex CLI 实际 MCP get_status                     | 通过，临时配置           | docs/MCP_SETUP.md；CLI 0.155.0-alpha.16，无全局配置改动                 |
| 演示库 MCP 追加、复盘、课程/卡片草稿、关联        | 通过                     | scripts/mcp-demo-write-test.mjs；权限结束后恢复                         |
| Host、Origin、会话、CSRF、Bearer 与 MCP 禁止操作  | 通过                     | artifacts/test-results/http-security.txt                                |
| 浏览器课程→主题→原文→记录→反馈                    | 通过                     | docs/UI_TEST_REPORT.md、scripts/ui-test.mjs                             |
| 保存失败保留输入、同请求重试不重复                | 通过，真实浏览器模拟断网 | docs/UI_TEST_REPORT.md                                                  |
| 阅读位置恢复与重开页面                            | 通过                     | docs/UI_TEST_REPORT.md                                                  |
| 390 / 768 / 1280px 无横向溢出                     | 通过                     | artifacts/screenshots/                                                  |
| 记录归档恢复、关联建议本地审核                    | 通过                     | docs/UI_TEST_REPORT.md                                                  |
| Markdown / TXT / JSON / ZIP 导入与去重            | 通过                     | tests/domain.test.ts、security.test.ts                                  |
| ZIP 越界、符号链接、体积异常拒绝                  | 通过                     | tests/security.test.ts                                                  |
| 同名新来源版本，旧引用仍打开旧文本                | 通过                     | tests/domain.test.ts、security.test.ts                                  |
| 覆盖遗漏与非法引用拒绝、并发草稿冲突              | 通过                     | tests/domain.test.ts                                                    |
| 知识卡跨两个主题，资料更新保留用户层              | 通过                     | tests/security.test.ts；DEMO 卡关联两门课                               |
| 课程导出不夹带笔记；个人记录范围授权              | 通过                     | tests/security.test.ts、domain.test.ts                                  |
| 中文连续文本、两字词、别名、繁简体                | 通过                     | tests/security.test.ts                                                  |
| 备份预览隔离、确认恢复、坏哈希拒绝                | 通过                     | tests/domain.test.ts、security.test.ts                                  |
| 服务重启后真实来源与草稿仍在                      | 通过                     | 本机启动/停止脚本实跑及数据库只读核对                                   |
| 100课程/2000卡/10000短记录性能                    | 实测完成                 | docs/PERFORMANCE.md，服务层延迟，不含浏览器/MCP网络开销                 |

## 限制与尚未验证

- 用户点名的完整资料包未在本轮授权目录找到，尚未进行该真实资料包的字段映射和全量入库验收。通用入口已实现，未知 JSON 会报告未匹配，不静默跳过。
- 真实材料的内容质量仅做了小范围阅读与 AI 讲义草稿；没有逐段复听或事实核验。真实草稿的正式采用仍由用户处理。机器结构校验不代表语义正确。
- PDF/DOCX 原件识别为不支持导入，可单独提取成文本；本版没有内置适配器或 OCR。
- 源码备份恢复 schema=1 实测；跨 schema 自动迁移、远程 MCP、云端连接、其他客户端和其他操作系统尚未验证。
- 当前 Codex 桌面会话未自动热加载新 MCP；CLI 真实调用通过，永久配置需执行提供的安装命令。
- 键盘焦点与语义标签有实现；没有完成独立屏幕阅读器审计。
- 截图来自功能运行页面，不是设计效果图。工程 DEMO 不是用户真实课程或经历。
