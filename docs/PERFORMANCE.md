# v1.1 长正文与协议传输实测

2026-09-24，Node 26 / macOS arm64。`scripts/long-fixture.ts` 在临时目录生成 3 个长来源版本、300 张长正文知识卡、160 条记录、40 篇长复盘，不含用户资料。通过真实 HTTP 和官方 MCP SDK stdio 逐项测量；原始 JSON 见 `artifacts/test-results/long-benchmark.json`。

每项为一次串行测量，时间包含请求和响应读取，不是统计 P95。字节数是 JSON 序列化 UTF-8 大小；MCP 的 text 与 structuredContent 会重复承载数据，所以数值通常更大。

| 通道      | 操作               | 响应 ms | JSON 字节 |
| --------- | ------------------ | ------: | --------: |
| HTTP      | list_courses       |    8.12 |     2,161 |
| HTTP      | get_course         |    5.22 |     7,840 |
| HTTP      | get_topic          |   30.04 |   268,600 |
| HTTP      | get_source_excerpt |   19.72 |     9,968 |
| HTTP      | list_knowledge     |   29.57 |   129,294 |
| HTTP      | list_notes         |    1.98 |    19,594 |
| HTTP      | search_library     |  116.01 |    14,228 |
| MCP stdio | list_knowledge     |   62.13 |   261,082 |
| MCP stdio | list_notes         |    4.56 |    40,982 |
| MCP stdio | search_library     |  108.34 |    70,280 |
| MCP stdio | get_source_excerpt |   22.28 |    20,892 |

列表默认每页 30 项，最大 100；正文采用 360 字符摘要，详情工具保留完整内容；来源片段默认 3 段，最大 20。读取结果整体超过 2 MiB 会明确提示缩小范围，不能在不知情时截断。此次 `list_knowledge(limit=50)` HTTP 响应约 129 KB，修复前同夹具约 1.11 MB；这是该夹具的实测改善，不承诺所有资料比例相同。

本测试覆盖长正文和协议成本，不代表用户真实资料体积、并发负载或浏览器绘制速度。复跑：先 `npm run build`，再 `node scripts/long-benchmark.mjs`，脚本自动清理临时库。

---

# v1.0 历史服务层基准

此报告由 `scripts/benchmark.ts` 在 2026-09-24T09:53:41.921Z 生成。测试数据库位于操作系统临时目录，结束后自动删除。所有课程、知识卡和记录都是代码生成的 DEMO 数据，不含用户资料。

## 环境与数据规模

- Node.js：v26.0.0
- 平台：darwin/arm64
- CPU：Apple M4
- SQLite：Node.js 内置 `node:sqlite`
- 数据：100 门课程、每课 3 个主题、2,000 张知识卡、10,000 条短记录；搜索词“基准”命中 12,100 条记录。
- 初始化耗时：518.8 ms（单事务插入，包含修订快照）。
- 预热后每类测量 30 次；响应时间按每次完整 `Service.invoke` 调用计。

## 结果

| 操作                         | 样本 |      P50 |      P95 |     平均 |
| ---------------------------- | ---: | -------: | -------: | -------: |
| 打开课程（`get_course`）     |   30 |  0.38 ms |  0.51 ms |  0.46 ms |
| 中文搜索（课程、知识、记录） |   30 | 46.91 ms | 49.58 ms | 47.33 ms |
| 新增短记录（`create_note`）  |   30 |  0.14 ms |  0.20 ms |  0.16 ms |

## 测量边界

这是本机 Node 服务层和 SQLite 的隔离库基准，未通过浏览器、HTTP 或 MCP 传输测量，也不代表用户真实课程、附件体积或多人并发。课程打开对象包含 3 个 DEMO 主题，没有来源段落；搜索词“基准”预期命中 12,100 条共同匹配记录，用于测量数据库扫描、结果排序和分页。报告仅在运行脚本时更新：

```sh
npx tsx scripts/benchmark.ts
```
