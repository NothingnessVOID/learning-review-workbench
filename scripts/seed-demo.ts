import { Service } from "../src/domain/service.js";
import { resolve } from "node:path";
import { uid } from "../src/domain/store.js";
const dir = process.argv[2];
if (!dir) throw Error("请指定独立演示数据目录");
const service = new Service(resolve(dir), process.cwd());
async function call(tool: string, args: any = {}) {
  const r = await service.invoke(tool, args);
  if (!r.ok) throw Error(JSON.stringify(r.error));
  return r.data as any;
}
service.store.setting("mode", "demo");
if (service.store.all("courses").length === 0) {
  for (const [index, title] of [
    "留下一句，慢慢看清",
    "从一次回看到下一步行动",
  ].entries()) {
    const raw = `# DEMO · ${title}\n\n这是独立的功能演示，不是用户课程或用户经历。\n\n## 先把发生的事记下来\n\n虚构情境：一个人讨论后感到不舒服。他先写下可观察到的经过，再保留疑问。记录无需立刻得出结论。\n\n## 将理解留给自己\n\n演示说明：阅读整理稿之后，可以记一句自己的理解。材料更新不会代替读者的判断，也不会覆盖记录。\n\n## 回到后续行动\n\n虚构情境：过两天，他补记了沟通经过。新的反馈与原事件关联，原始输入仍然保留。\n`;
    const preview = await call("preview_import", {
      files: [
        {
          name: `DEMO-${index}.md`,
          content_base64: Buffer.from(raw).toString("base64"),
        },
      ],
      source_kind: "other",
      series: "DEMO · 使用练习",
    });
    const imported = await call("commit_import", { preview_id: preview.id });
    const c = await call("get_course", {
      course_id: imported.imported[0].course_id,
    });
    let cursor: string | null = "0",
      blocks: any[] = [];
    while (cursor !== null) {
      const ex = await call("get_source_excerpt", {
        source_version_id: c.source_version_ids[0],
        cursor,
        limit: 20,
      });
      blocks.push(...ex.blocks);
      cursor = ex.next_cursor;
    }
    const topics = [
      {
        id: uid("topic"),
        title: "先记下事件，给理解留一点空间",
        parent_id: null,
        order: 0,
        content_kind: "main_teaching",
        blocks: [
          {
            type: "explanation",
            body_md:
              "这是一段功能演示讲义。\n\n事情刚发生时，可以先留下短短一句，保存当时可确认的经过与感受。不必急着命名，也不必先知道它属于哪张知识卡。\n\n稍后回看时，原始输入与新的理解分开放置。这样能分清：当时真正说了什么，后来又补充了什么。\n\n资料的整理状态和自己的学习状态也彼此独立。读过一段内容，并不自动代表能够解释或已经实践。",
            origin_kind: "demo_material",
            transformation: "ai_paraphrase",
            source_refs: blocks.map((b) => ({
              source_document_id: b.source_document_id,
              source_version_id: b.source_version_id,
              source_block_id: b.id,
            })),
            verification_status: "demo",
          },
        ],
      },
      {
        id: uid("topic"),
        title: "回看与行动",
        parent_id: null,
        order: 1,
        content_kind: "supplement",
        blocks: [
          {
            type: "example",
            body_md:
              "**独立演示案例**\n\n讨论后的当天先记一句，两天后再添加反馈。两条记录连接成一条时间线，最初的记录不会被新的解释改写。",
            origin_kind: "demo_material",
            transformation: "ai_example",
            source_refs: [],
            verification_status: "demo",
          },
        ],
      },
    ];
    const draft = await call("submit_course_draft", {
      course_id: c.id,
      title: `DEMO · ${title}`,
      series: "DEMO · 使用练习",
      overview:
        "从一门课程出发，练习阅读主题、查回原文、记下一句，再回看自己的记录。此处内容全部为独立演示。",
      expected_revision: c.revision,
      source_version_ids: c.source_version_ids,
      topics,
      coverage: blocks.map((b) => ({
        source_block_id: b.id,
        disposition: "main_teaching",
        topic_ids: [topics[0].id],
      })),
      client_request_id: uid("req"),
    });
    await call("review_draft", {
      draft_id: draft.id,
      action: "accept",
      expected_revision: draft.revision,
    });
  }
  const courses = (await call("list_courses")).items;
  const first = await call("get_course", { course_id: courses[0].id }),
    second = await call("get_course", { course_id: courses[1].id });
  const card = await call("submit_knowledge_draft", {
    title: "DEMO · 保留原始输入",
    aliases: ["原话", "原始记录", "黑金心力疗愈"],
    type: "method",
    body_md:
      "演示方法：先保存原始文字，再追加理解或复盘。\n\n这张卡关联两门演示课程，展示跨课程复用。它并不代表已经掌握任何黑金方法。",
    source_refs: first.topics[0].blocks[0].source_refs,
    topic_ids: [first.topics[0].id, second.topics[0].id],
    expected_revision: 0,
    client_request_id: uid("req"),
  });
  await call("review_draft", {
    draft_id: card.id,
    action: "accept",
    expected_revision: card.revision,
  });
  const note = await call("create_note", {
    original_text: "DEMO：这是一条用于展示时间线的虚构记录，不是我的真实经历。",
    type: "event",
    relation_ids: [first.topics[0].id],
    client_request_id: uid("req"),
  });
  await call("save_review_result", {
    note_ids: [note.id],
    body_md: "演示整理：保留记录中的问题。下一步由使用者自己决定。",
    basis: ["DEMO 原始记录"],
    gaps: ["未使用完整黑金方法资料"],
    client_request_id: uid("req"),
  });
  await call("create_note", {
    original_text: "DEMO：两天后补充的虚构反馈。",
    type: "feedback",
    parent_note_id: note.id,
    client_request_id: uid("req"),
  });
  await call("set_learning_state", {
    object_id: first.id,
    status: "reading",
    position: { topic_id: first.topics[0].id, scroll: 0 },
  });
  await call("submit_knowledge_draft", {
    title: "DEMO · 待审知识补充",
    type: "concept",
    body_md: "这是一条待审草稿，用来检验确认采用与撤回。",
    source_refs: first.topics[0].blocks[0].source_refs,
    topic_ids: [first.topics[0].id],
    expected_revision: 0,
    client_request_id: uid("req"),
  });
}
console.log(JSON.stringify({ demo_dir: dir, counts: service.store.counts() }));
service.store.close();
