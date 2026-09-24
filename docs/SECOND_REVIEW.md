# 第二轮复审：1.2

基准提交 `109a904d77f98f50a78ce768a7a5c57891386084`。本轮延续原有 SQLite、本地网页和 MCP 架构。附件中的隔离逻辑复现作为线索；交付结论以真实仓库、临时数据库、浏览器和官方 SDK 的结果为准。

## 先复现，再修复

将 Git 中的固定基准解包到独立目录，只加入随附的五项测试模板；五项全部失败。完整测试日志（仅清理行尾空白）在 `artifacts/test-results/second-baseline.txt`。修复后模板跟随真实新接口更新，仍保留原来的持久化、日期、关联和删除检测断言，并扩展边界情况；没有通过允许任意 ID 或删断言取得通过。

| 编号 | 最终行为                                                                                | 主要位置与验证                                                                                                 |
| ---- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| B01  | 讲义锚点与原文区段 ID 分开，服务器校验所属主题和课程；旧块有稳定只读 ID；保存失败有提示 | service.ts、reading.ts；habit / second-boundaries 测试；真实浏览器清缓存和 SQLite 检查                         |
| B02  | 日期输入转为浏览器本地半开时间区间；发生时间优先，未记录时明确用写入时间                | dates.ts、api.ts、共享合同与服务筛选；Singapore / 两个 DST 日测试及日期输入浏览器测试                          |
| B03  | 任何交接范围或主记录改变，都使在途及已完成预览失效；复制下载绑定当前快照                | App.tsx、handoff.ts；延迟 RPC 浏览器检查                                                                       |
| B04  | 审核读取完整旧讲义和拟采用正文，带修订号及比较 token；旧快照不能采用                    | get_draft_comparison、review_draft、DraftPage；不变/改句/删条件/删块/新增示例/换引用/移除主题与过期 token 检查 |
| B05  | 直接关联与确认关系在两端、筛选及交接来源采用同一读取规则                                | resolvedRelations / notesFor；确认、拒绝、未确认、反向关联和权限检查                                           |
| B06  | 明确选择先前复盘、反馈和方法意图；保留时间、固定来源 ID、截断/遗漏及接收端能力待核说明  | reviewHandoff / handoffMarkdown；回连记录也受保存版本保护                                                      |
| B07  | 课程摘要返回整理状态，知识摘要返回核验状态；缺字段显示明确提示                          | list_courses / list_knowledge 与列表 DOM 检查                                                                  |
| B08  | 新增两个受限只读 MCP 详情工具；搜索结果可取全文并查回原始记录或来源                     | 23 工具；实际 stdio 搜索→详情→出处，撤权后拒绝                                                                 |
| B09  | 记一句打开即聚焦文本框；写理解可默认理解类型，已有草稿优先                              | useDialogFocus / openComposer；直接键盘输入、焦点循环和 Escape 检查                                            |

## 本轮实测结果

应用源码指纹：`b99920d8e818843a96bb71f3a926b79b4eff18159cec19ca15551de7cafe4970`。构建时基准提交为 109a904，测试包含本轮尚未提交的源码变更；最终发布构建另记录实际提交。测试使用 Node 26、本机 Google Chrome（通过 `PLAYWRIGHT_EXECUTABLE_PATH` 指定）；CI 使用 Node 24 与 Playwright Chromium。

| 检查                                  | 结果与证据                                                           |
| ------------------------------------- | -------------------------------------------------------------------- |
| 固定 109a904 上附件的 5 项模板        | 5 项失败，`artifacts/test-results/second-baseline.txt`               |
| 单元、集成、权限、恢复及边界          | 61/61 通过，`artifacts/test-results/second-unit.txt`                 |
| 类型检查及生产构建                    | 通过，`artifacts/test-results/second-build.txt`                      |
| 阅读/保存/审核/导出原有浏览器回归     | `artifacts/test-results/second-ui.txt`                               |
| 新增 B01/B02/B04/B05/B07 跨层浏览器   | 通过，`artifacts/test-results/second-habit-ui.txt`                   |
| 新增 B03/B06/B09 交接竞态与焦点浏览器 | 通过，`artifacts/test-results/second-handoff-ui.txt`                 |
| HTTP 隔离与安全                       | 通过，`artifacts/test-results/second-http.txt`                       |
| SDK 协议及真实全文回查                | 通过，`artifacts/test-results/second-protocol.txt`、`second-mcp.txt` |
| 长资料 HTTP/MCP 读取基准              | 通过，`artifacts/test-results/second-benchmark.txt`                  |

合成截图：`artifacts/habit-regression/` 与 `artifacts/handoff-regression/`。相关记录的独立历史复盘与反馈可以明确选择；取消相关记录同时取消其附带内容。权限交叉审查还补上了私有案例在关联元数据中的过滤，pending/confirmed 关系以及撤销笔记授权均有断言。

## 可复跑命令

```sh
npm ci
npm run build
npm test
node scripts/mcp-protocol-test.mjs
npm run test:http
npx playwright install chromium
npm run test:e2e
npm run test:habit-mcp
node scripts/habit-ui-test.mjs
node scripts/handoff-ui-test.mjs
```

浏览器使用独立临时端口与临时数据库，默认 Playwright Chromium；可用 `PLAYWRIGHT_EXECUTABLE_PATH` 指定本机浏览器。每次测试结束关闭自己的服务并清理临时库。所有公开截图、日志和夹具都来自合成数据。真实资料样本验证单独使用私有临时目录，证据不公开。

## 验收边界

保存、找回、筛选、关联、审核和交接的工程正确性由上述自动化与真实浏览器测试回答，不交由使用者代跑工程清单。个人主观体验、课程语义是否忠实、完整方法 Skill 在接收端的实际执行效果，仍由实际使用与内容审阅判断。

现有备份恢复、保存新输入保护、导出参数失效、不可变来源与个人层隔离继续保留原有回归。软件没有新增云端模型、自动抽牌、公开部署或私人上下文上传。

## 实际资料包的小样本验证

在本机找到此前未取得的实际资料总包，做了只读盘点及隔离预览。包内有 710 个文件，Markdown 和 DOCX 各 355 份。产品当前的通用 ZIP 预览会把 Markdown 视为文本来源，DOCX 标为不支持，不会自动将其中 189 张观点卡和 118 张案例卡识别成对应资料实体。完整 ZIP 没有提交到正式库。

另选同一明确回链下的四份 Markdown（转写、整理稿、观点卡、案例卡），在新临时库验证：4/4 原始字节与来源快照哈希一致；通过本地临时映射脚本按现有元数据生成课程草稿、知识草稿和案例；两处时间标记在对应转写中唯一定位，可按固定引用查回。先采纳依赖卡片被拒绝，先课程后卡片通过；重复导入四份来源及结构包均被识别，来源版本未增加。

该验证证明小样本的保真与显式映射机制，不等于产品已经内置整包自动适配。其余卡片、全量回链、DOCX 读取与逐段语义仍未完成全量验收；没有原音时不声称音频真实性或转录准确性已确认。真实内容、文件名、回链和测试报告只保留本机私有目录，不进入公开仓库。
