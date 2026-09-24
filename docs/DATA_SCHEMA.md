# 数据与导入合同 v1.0.0

主库 SQLite `workbench.sqlite`，schema user_version=1。每个实体有稳定 ID、修订号、创建/修改 UTC 时间（ISO 8601）、软归档标志、父对象索引、标题和检索规范化文本，以及该对象的结构化字段 JSON。并非一个全库 JSON；对象逐行事务保存。原文存文件原始字节，关系由业务层校验。

| 表 | 内容 |
|---|---|
| sources | 原文件名、来源种类、权限、讲者与真实日期（可空） |
| versions | 来源文件 ID、SHA-256、快照相对路径、导入时间；不可修改 |
| blocks | 固定版本、原始顺序、标题路径、原文和真实行范围；不可修改 |
| courses / topics | 课程元数据、来源版本、主题父子层级、顺序与讲义内容块 |
| cards / cases | 知识资料层、原名类型别名、来源、案例身份与关联 |
| notes / reviews | 原始输入、可选发生时间、后续事件关系；复盘独立存储 |
| relations | 两端 ID、关系类型、理由、引用、待确认/确认/拒绝 |
| learning | 对象的用户学习状态和阅读位置，不随导入覆盖 |
| drafts / revisions / audit | 草稿批次、历次对象修订、操作者及请求审计 |
| requests | 请求 ID 与内容摘要和原结果，保证相同请求重试幂等 |
| settings / import_previews | 本地权限、暂存预览和下载文件索引 |

所有涉及来源的引用必须有 `source_document_id`、`source_version_id`、`source_block_id` 且关系一致。课程 coverage 对指定来源版本的每个区段给出去向，来源可定位与语义忠实是两个不同结论。

机器可读写入 schema 位于 `schemas/*.json`；MCP `get_schema` 返回相同 Zod 导出结果。逐工具合同在 API_CONTRACT.md。知识卡更新需要 expected_revision，个人学习层存独立表，不接受在资料包里覆盖 notes 或 learning。

## 导入

Markdown/TXT 用 UTF-8 原样保存，按段落/标题生成固定区段和原文目录。明确存在的“直播日期：YYYY年M月D日”头可识别为真实日期；缺失时为空，不拿文件导入日期顶替。

JSON 可以是 `course_draft`、`knowledge_draft`，或 `manifest.json`：

```json
{
  "schema_version": "1.0.0",
  "sources": [{"path": "sources/课件.md"}],
  "courses": [],
  "knowledge": [],
  "cases": []
}
```

课程/知识数组各项采用对应草稿 schema。sources 引用 ZIP 中存在的文件；第一版结构化草稿的引用需要使用已经导入后分配的来源 ID。新来源与新整理稿的可靠路径是先导入来源，在 `get_course`/`get_source_excerpt` 取得 ID，再由 Agent 提交草稿。不会猜测 legacy 包的任意字段或把未知 JSON 当作原文忽略错误。

同哈希跳过，重复已提交的结构化文件也跳过；同名异文产生新来源版本，旧引用不迁移。资料包预览报告重复、未知格式、解析错误；正文来源保留，不执行 HTML 或脚本。

限制：一批最多 1000 文件，展开总量 64 MiB，普通文本/ZIP成员上限 8 MiB；只允许 Store/Deflate ZIP，拒绝绝对路径、上级路径、反斜线、链接、加密项和异常长度。PDF/DOCX 在预览标为不支持，原文件保留在用户原路径，可独立转文本后导入。

## 导出

阅读迁移导出包含 `data.json`、每项 Markdown、原来源快照与说明，保留 ID 与来源关系。导出本身不是第二主本，不支持文件直接双向编辑。分享模式剔除原始快照并仅按用户指定词替换，下载前必须看预览。备份包与阅读导出是不同格式，只有备份用于全库恢复。

## 草稿与回退

接受草稿时同时检查草稿和正式资料修订号；资料更新保留对象历史与修改前主题。撤回仅在正式对象没有后续修订时执行，避免覆盖后来的变更。旧主题可归档但不级联删除笔记。个人记录可归档；本版不做永久删除。
