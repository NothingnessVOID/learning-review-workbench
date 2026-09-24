import { writeFileSync } from "node:fs";
import { resolve, join, basename } from "node:path";
import { tmpdir } from "node:os";
import { Service } from "../src/domain/service.js";
import { uid } from "../src/domain/store.js";

const dir = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("fixture needs an isolated data directory");
if (dir.slice(0, tmpdir().length) !== tmpdir() || !basename(dir).startsWith("workbench-e2e-")) {
  throw new Error("refusing to seed outside a workbench-e2e-* temporary directory");
}
const service = new Service(dir, process.cwd());
service.store.setting("mode", "demo");

async function call(tool: string, args: Record<string, unknown> = {}) {
  const result = await service.invoke(tool, args, "local_user") as any;
  if (!result.ok) throw new Error(`${tool}: ${JSON.stringify(result.error)}`);
  return result.data;
}

async function allSourceBlocks(versionId: string) {
  const blocks: any[] = [];
  let cursor: string | null = "0";
  while (cursor !== null) {
    const page = await call("get_source_excerpt", { source_version_id: versionId, cursor, limit: 20 });
    blocks.push(...page.blocks);
    cursor = page.next_cursor;
  }
  return blocks;
}

try {
  const longParagraphs = Array.from({ length: 18 }, (_, index) =>
    `DEMO long reading segment ${index + 1}. ` +
    "This synthetic passage makes a real scroll position measurable without using private lesson text. ".repeat(6),
  );
  const raw = [
    "# DEMO Second Pass Browser Fixture",
    "",
    "## DEMO short topic",
    "",
    "DEMO short block for immediate navigation.",
    "",
    "## DEMO long topic",
    "",
    "仅当条件成立时，才执行这项合成规则。",
    "",
    "这条 DEMO 例外仍需保留在讲义中。",
    "",
    ...longParagraphs.flatMap((line) => [line, ""]),
  ].join("\n");
  const preview = await call("preview_import", {
    files: [{ name: "DEMO-second-pass-browser.md", content_base64: Buffer.from(raw).toString("base64") }],
    source_kind: "cleaned_transcript",
    series: "DEMO only",
  });
  const committed = await call("commit_import", { preview_id: preview.id });
  const imported = committed.imported[0];
  const shell = await call("get_course", { course_id: imported.course_id });
  const sourceBlocks = await allSourceBlocks(shell.source_version_ids[0]);
  const shortTopicId = uid("topic");
  const longTopicId = uid("topic");
  const shortBlock = sourceBlocks.find((block) => block.text.includes("DEMO short block")) ?? sourceBlocks[0];
  const longBlocks = sourceBlocks.filter((block) => block.id !== shortBlock.id);
  const reference = (block: any) => ({
    source_document_id: block.source_document_id,
    source_version_id: block.source_version_id,
    source_block_id: block.id,
  });
  const lectureBlock = (block: any, topicIndex: number) => ({
    id: uid("tb"),
    type: "explanation",
    body_md: block.text.trim() + (topicIndex === 1 ? `\n\n${"DEMO continuation text. ".repeat(18)}` : ""),
    origin_kind: "course_material",
    transformation: "paraphrase",
    source_refs: [reference(block)],
    verification_status: "needs_review",
  });
  const shortTeaching = [lectureBlock(shortBlock, 0)];
  const longTeaching = longBlocks.map((block) => lectureBlock(block, 1));
  const topics = [
    { id: shortTopicId, title: "DEMO short topic", parent_id: null, order: 0, content_kind: "main_teaching", blocks: shortTeaching },
    { id: longTopicId, title: "DEMO long topic", parent_id: null, order: 1, content_kind: "main_teaching", blocks: longTeaching },
  ];
  const topicForSource = new Map<string, string>();
  topicForSource.set(shortBlock.id, shortTopicId);
  for (const block of longBlocks) topicForSource.set(block.id, longTopicId);
  const draft = await call("submit_course_draft", {
    course_id: shell.id,
    title: "DEMO Second Pass Browser Fixture",
    series: "DEMO only",
    overview: "Synthetic test-only course for browser and SQLite integration.",
    expected_revision: shell.revision,
    source_version_ids: shell.source_version_ids,
    topics,
    coverage: sourceBlocks.map((block: any) => ({
      source_block_id: block.id,
      disposition: "main_teaching",
      topic_ids: [topicForSource.get(block.id) ?? longTopicId],
    })),
    client_request_id: uid("req"),
  });
  const comparison = await call("get_draft_comparison", { draft_id: draft.id });
  await call("review_draft", {
    draft_id: draft.id,
    action: "accept",
    expected_revision: draft.revision,
    comparison_token: comparison.comparison_token,
  });
  const course = await call("get_course", { course_id: shell.id });
  const fullTopics = await Promise.all(course.topics.map((topic: any) => call("get_topic", { topic_id: topic.id })));
  const longTopic = fullTopics.find((topic: any) => topic.id === longTopicId)!;
  const shortTopic = fullTopics.find((topic: any) => topic.id === shortTopicId)!;

  const cardDraft = await call("submit_knowledge_draft", {
    title: "DEMO browser status card",
    type: "concept",
    body_md: "Synthetic verification status for UI assertions.",
    source_refs: longTopic.blocks.flatMap((block: any) => block.source_refs).slice(0, 2),
    topic_ids: [shortTopic.id, longTopic.id],
    expected_revision: 0,
    client_request_id: uid("req"),
  });
  await call("review_draft", { draft_id: cardDraft.id, action: "accept", expected_revision: cardDraft.revision });

  const dateNotes: Record<string, string> = {};
  const dateCases = [
    ["early", "2026-09-24T00:10:00+08:00"],
    ["late", "2026-09-24T23:59:00+08:00"],
    ["next", "2026-09-25T00:10:00+08:00"],
    ["previous", "2026-09-23T23:59:00+08:00"],
  ];
  for (const [key, occurredAt] of dateCases) {
    const note = await call("create_note", {
      original_text: `DEMO browser date ${key}`,
      type: "event",
      occurred_at: occurredAt,
      client_request_id: uid("req"),
    });
    dateNotes[key] = note.id;
  }
  const backfilled = await call("create_note", {
    original_text: "DEMO browser date backfilled outside selected day",
    type: "event",
    occurred_at: "2026-09-23T23:00:00+08:00",
    client_request_id: uid("req"),
  });
  const backfillCreated = "2026-09-24T04:00:00.000Z";
  const backfillValue = service.store.get("notes", backfilled.id)!;
  service.store.db.prepare("UPDATE notes SET created_at=?,data=? WHERE id=?")
    .run(backfillCreated, JSON.stringify({ ...backfillValue, created_at: backfillCreated }), backfilled.id);
  const fallback = await call("create_note", {
    original_text: "DEMO browser date created-time fallback",
    type: "quick",
    client_request_id: uid("req"),
  });
  const fallbackCreated = service.store.get("notes", fallback.id)!;
  service.store.db.prepare("UPDATE notes SET created_at=?,data=? WHERE id=?")
    .run(backfillCreated, JSON.stringify({ ...fallbackCreated, created_at: backfillCreated, occurred_at: null }), fallback.id);
  dateNotes.backfilled = backfilled.id;
  dateNotes.fallback = fallback.id;

  const primary = await call("create_note", {
    original_text: "DEMO browser B05 linked note",
    type: "event",
    occurred_at: "2026-09-24T12:00:00+08:00",
    client_request_id: uid("req"),
  });
  const relation = await call("propose_relations", {
    relations: [{ from_id: primary.id, to_id: longTopic.id, kind: "related_to", reason: "DEMO confirmed relation" }],
    client_request_id: uid("req"),
  });
  await call("review_relation", { relation_id: relation.items[0].id, status: "confirmed" });

  const changedTopics = fullTopics.map((topic: any) => ({
    id: topic.id,
    title: topic.title,
    parent_id: topic.parent_id ?? null,
    order: topic.order,
    content_kind: topic.content_kind,
    revision: topic.revision,
    blocks: topic.blocks.map((block: any) => ({
      id: block.id,
      type: block.type,
      body_md: block.body_md,
      origin_kind: block.origin_kind,
      transformation: block.transformation,
      source_refs: block.source_refs,
      verification_status: block.verification_status,
    })),
  }));
  const longChanged = changedTopics.find((topic: any) => topic.id === longTopic.id)!;
  const condition = longChanged.blocks.find((block: any) => block.body_md.includes("仅当条件成立"));
  if (condition) condition.body_md = "执行这项 DEMO 合成规则。";
  const removed = longChanged.blocks.pop();
  const removedSourceId = removed?.source_refs?.[0]?.source_block_id;
  const pendingDraft = await call("submit_course_draft", {
    course_id: course.id,
    title: course.title,
    series: course.series,
    overview: course.overview,
    expected_revision: course.revision,
    source_version_ids: course.source_version_ids,
    topics: changedTopics,
    coverage: sourceBlocks.map((block: any) => block.id === removedSourceId
      ? { source_block_id: block.id, disposition: "retained", topic_ids: [] }
      : { source_block_id: block.id, disposition: "main_teaching", topic_ids: [topicForSource.get(block.id) ?? longTopic.id] }),
    client_request_id: uid("req"),
  });

  const selectedRelated = await call("create_note", {
    original_text: "DEMO browser B03 related note",
    type: "understanding",
    client_request_id: uid("req"),
  });
  const feedback = await call("create_note", {
    original_text: "DEMO browser B03 feedback",
    type: "feedback",
    parent_note_id: primary.id,
    client_request_id: uid("req"),
  });
  const review = await call("save_review_result", {
    note_ids: [primary.id],
    body_md: "DEMO browser selected review",
    basis: ["synthetic only"],
    gaps: [],
    client_request_id: uid("req"),
  });

  writeFileSync(join(dir, "habit-fixture.json"), JSON.stringify({
    course_id: course.id,
    course_title: course.title,
    short_topic_id: shortTopic.id,
    long_topic_id: longTopic.id,
    short_block_id: shortTopic.blocks[0].id,
    long_block_ids: longTopic.blocks.map((block: any) => block.id),
    knowledge_card_id: cardDraft.entity_id,
    knowledge_title: "DEMO browser status card",
    primary_note_id: primary.id,
    related_note_id: selectedRelated.id,
    feedback_note_id: feedback.id,
    review_id: review.id,
    draft_id: pendingDraft.id,
    removed_block_id: removed?.id,
    condition_text: "仅当条件成立时，才执行这项合成规则。",
    date_notes: dateNotes,
    expected_date_note_texts: ["DEMO browser date early", "DEMO browser date late", "DEMO browser date created-time fallback"],
  }, null, 2));
  console.log(JSON.stringify({ fixture: "synthetic-only", course_id: course.id, topics: fullTopics.length, source_blocks: sourceBlocks.length }));
} finally {
  service.store.close();
}
