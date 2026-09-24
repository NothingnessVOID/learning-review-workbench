/**
 * Second-pass cross-layer regressions. Every Service uses a fresh temporary
 * data directory and synthetic DEMO text; no production or demo DB is opened.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Service } from "../src/domain/service.js";
import { calendarDateRange } from "../src/web/dates.js";
import { readableChanges } from "../src/web/diff.js";

type Rpc = { ok: boolean; data?: any; error?: { code: string; message: string } };
const syntheticSource = `# DEMO second-pass course

DEMO test-only introduction.

## DEMO conditions

仅当条件成立时，才执行这项合成规则。

这条 DEMO 例外仍需保留在讲义中。

## DEMO second topic

这是第二个合成主题中的一条记录。
`;

async function withService(run: (service: Service, dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "workbench-habit-review-"));
  const service = new Service(dir, process.cwd());
  try {
    await run(service, dir);
  } finally {
    service.store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

async function invoke(service: Service, tool: string, args: Record<string, unknown> = {}) {
  return (await service.invoke(tool, args, "local_user")) as Rpc;
}

async function data(service: Service, tool: string, args: Record<string, unknown> = {}) {
  const result = await invoke(service, tool, args);
  assert.equal(result.ok, true, `${tool}: ${JSON.stringify(result.error)}`);
  return result.data;
}

async function rejects(service: Service, tool: string, args: Record<string, unknown>, code: string) {
  const result = await invoke(service, tool, args);
  assert.equal(result.ok, false, `${tool} unexpectedly succeeded`);
  assert.equal(result.error?.code, code, `${tool}: ${JSON.stringify(result.error)}`);
}

async function seedCourse(service: Service) {
  const preview = await data(service, "preview_import", {
    files: [{ name: "DEMO-second-pass.md", content_base64: Buffer.from(syntheticSource).toString("base64") }],
    source_kind: "cleaned_transcript",
    series: "DEMO only",
  });
  const committed = await data(service, "commit_import", { preview_id: preview.id });
  const course = await data(service, "get_course", { course_id: committed.imported[0].course_id });
  const topics = await Promise.all(course.topics.map((topic: any) => data(service, "get_topic", { topic_id: topic.id })));
  const sourceBlocks: any[] = [];
  let cursor: string | null = "0";
  const versionId = course.source_version_ids[0];
  while (cursor !== null) {
    const page = await data(service, "get_source_excerpt", { source_version_id: versionId, cursor, limit: 20 });
    sourceBlocks.push(...page.blocks);
    cursor = page.next_cursor;
  }
  return { course, topics, sourceBlocks };
}

function schemaTopic(topic: any) {
  return {
    id: topic.id,
    title: topic.title,
    parent_id: topic.parent_id ?? null,
    order: topic.order,
    content_kind: topic.content_kind,
    revision: topic.revision,
    blocks: (topic.blocks ?? []).map((block: any) => ({
      id: block.id,
      type: block.type ?? "explanation",
      body_md: block.body_md,
      origin_kind: block.origin_kind ?? "course_material",
      transformation: block.transformation ?? "paraphrase",
      source_refs: block.source_refs ?? [],
      verification_status: block.verification_status ?? "needs_review",
    })),
  };
}

function courseDraft(course: any, topics: any[], sourceBlocks: any[], request: string = randomUUID()) {
  const normalizedTopics = topics.map(schemaTopic);
  const coverage = sourceBlocks.map((block, index) => ({
    source_block_id: block.id,
    disposition: "main_teaching",
    topic_ids: [normalizedTopics[index % normalizedTopics.length].id],
  }));
  return {
    course_id: course.id,
    title: course.title,
    series: course.series,
    course_date: course.course_date,
    overview: course.overview ?? "",
    expected_revision: course.revision,
    source_version_ids: course.source_version_ids,
    topics: normalizedTopics,
    coverage,
    client_request_id: request,
  };
}

function comparableChanges(comparison: any) {
  const current = comparison.current_course
    ? { ...comparison.current_course, topics: comparison.current_topics }
    : null;
  const proposed = { ...comparison.proposed_course, topics: comparison.proposed_topics };
  return readableChanges(current, proposed, "course");
}

test("B01: teaching-block anchors persist through a fresh Service and reject cross-topic IDs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "workbench-habit-b01-"));
  let service = new Service(dir, process.cwd());
  try {
    const { course, topics } = await seedCourse(service);
    assert.ok(topics.length >= 2, "fixture must include separate topics");
    const first = topics[0];
    const block = first.blocks[0];
    const saved = await data(service, "set_learning_state", {
      object_id: course.id,
      position: { topic_id: first.id, teaching_block_id: block.id, block_offset: 35, scroll: 950 },
    });
    assert.equal(saved.position.teaching_block_id, block.id);

    const stored = service.store.db.prepare("SELECT data FROM learning WHERE id=?").get(course.id) as { data: string };
    assert.equal(JSON.parse(stored.data).position.teaching_block_id, block.id);
    await rejects(service, "set_learning_state", {
      object_id: course.id,
      position: { topic_id: first.id, teaching_block_id: topics[1].blocks[0].id },
    }, "SOURCE_REF_INVALID");

    const sourceRef = block.source_refs[0];
    assert.ok(sourceRef?.source_block_id, "fixture lecture block must point to its immutable source block");
    const legacy = await data(service, "set_learning_state", {
      object_id: course.id,
      position: { topic_id: first.id, block_id: sourceRef.source_block_id, block_offset: 12 },
    });
    assert.equal(legacy.position.teaching_block_id, block.id, "legacy source anchors resolve only through a reference inside the chosen topic");
    await rejects(service, "set_learning_state", {
      object_id: course.id,
      position: { topic_id: first.id, block_id: topics[1].blocks[0].source_refs[0].source_block_id },
    }, "SOURCE_REF_INVALID");

    service.store.close();
    service = new Service(dir, process.cwd());
    const reopened = await data(service, "get_course", { course_id: course.id });
    assert.equal(reopened.learning_state.position.teaching_block_id, block.id, "server-side position must survive process/context recreation");
    assert.equal(reopened.learning_state.position.block_offset, 12);
  } finally {
    service.store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("B02: Singapore date inputs become a local half-open interval and use occurred_at before created_at", async () => {
  await withService(async (service) => {
    const previousTz = process.env.TZ;
    process.env.TZ = "Asia/Singapore";
    try {
      const range = calendarDateRange({ from: "2026-09-24", to: "2026-09-24", limit: 100 });
      assert.equal(range.from, "2026-09-23T16:00:00.000Z");
      assert.equal(range.to_exclusive, "2026-09-24T16:00:00.000Z");
      assert.equal("to" in range, false, "UI date inputs use a half-open upper bound");

      const stamps = [
        "2026-09-24T00:10:00+08:00",
        "2026-09-24T23:59:00+08:00",
        "2026-09-25T00:10:00+08:00",
        "2026-09-23T23:59:00+08:00",
      ];
      const notes: any[] = [];
      for (const occurred_at of stamps) {
        notes.push(await data(service, "create_note", {
          original_text: `DEMO date boundary ${occurred_at}`,
          type: "event",
          occurred_at,
          client_request_id: randomUUID(),
        }));
      }
      const createdInsideOccurredOutside = await data(service, "create_note", {
        original_text: "DEMO created inside but occurred outside",
        type: "event",
        occurred_at: "2026-09-23T23:00:00+08:00",
        client_request_id: randomUUID(),
      });
      const value = service.store.get("notes", createdInsideOccurredOutside.id)!;
      const createdAt = "2026-09-24T04:00:00.000Z";
      service.store.db.prepare("UPDATE notes SET created_at=?,data=? WHERE id=?")
        .run(createdAt, JSON.stringify({ ...value, created_at: createdAt }), value.id);
      const missingOccurredInside = await data(service, "create_note", {
        original_text: "DEMO missing occurrence uses creation day",
        type: "quick",
        client_request_id: randomUUID(),
      });
      const fallback = service.store.get("notes", missingOccurredInside.id)!;
      service.store.db.prepare("UPDATE notes SET created_at=?,data=? WHERE id=?")
        .run(createdAt, JSON.stringify({ ...fallback, created_at: createdAt, occurred_at: null }), fallback.id);

      const filtered = await data(service, "list_notes", range);
      const ids = new Set(filtered.items.map((item: any) => item.id));
      assert.deepEqual(ids, new Set([notes[0].id, notes[1].id, missingOccurredInside.id]));
      assert.ok(!ids.has(notes[2].id), "the next local midnight is outside the selected day");
      assert.ok(!ids.has(createdInsideOccurredOutside.id), "a backfilled event is filtered by occurred_at, not its later entry timestamp");
      const fallbackRow = filtered.items.find((item: any) => item.id === missingOccurredInside.id);
      assert.equal(fallbackRow.occurred_at, null);
      assert.equal(fallbackRow.created_at, createdAt);

      const search = await data(service, "search_library", {
        query: "DEMO date boundary",
        types: ["note"],
        from: range.from,
        to_exclusive: range.to_exclusive,
        limit: 100,
      });
      assert.deepEqual(new Set(search.items.map((item: any) => item.id)), new Set([notes[0].id, notes[1].id]));
    } finally {
      if (previousTz === undefined) delete process.env.TZ;
      else process.env.TZ = previousTz;
    }
  });
});

test("B05/B06: confirmed links flow both ways and handoff includes only selected notes, feedback, reviews and sources", async () => {
  await withService(async (service) => {
    const { topics, sourceBlocks } = await seedCourse(service);
    const topic = topics[0];
    const main = await data(service, "create_note", {
      original_text: "DEMO primary reflection",
      type: "event",
      client_request_id: randomUUID(),
    });
    const related = await data(service, "create_note", {
      original_text: "DEMO explicitly selected related note",
      type: "understanding",
      client_request_id: randomUUID(),
    });
    const feedback = await data(service, "create_note", {
      original_text: "DEMO selected follow-up feedback",
      type: "feedback",
      parent_note_id: main.id,
      client_request_id: randomUUID(),
    });
    const unselectedFeedback = await data(service, "create_note", {
      original_text: "DEMO unselected feedback",
      type: "feedback",
      parent_note_id: main.id,
      client_request_id: randomUUID(),
    });
    const pending = await data(service, "propose_relations", {
      relations: [{ from_id: main.id, to_id: topic.id, kind: "related_to" }],
      client_request_id: randomUUID(),
    });
    const beforeConfirm = await data(service, "get_topic", { topic_id: topic.id });
    assert.ok(!beforeConfirm.notes.some((item: any) => item.id === main.id), "pending relations must not appear as confirmed links");
    await data(service, "review_relation", { relation_id: pending.items[0].id, status: "confirmed" });

    const detail = await data(service, "get_note", { note_id: main.id });
    assert.ok(detail.resolved_relations.some((item: any) => item.id === topic.id));
    const inverse = await data(service, "get_topic", { topic_id: topic.id });
    assert.ok(inverse.notes.some((item: any) => item.id === main.id));
    const filtered = await data(service, "list_notes", { relation_id: topic.id, limit: 100 });
    assert.ok(filtered.items.some((item: any) => item.id === main.id));

    const review = await data(service, "save_review_result", {
      note_ids: [main.id, related.id],
      body_md: "DEMO previously selected review",
      basis: ["DEMO synthetic input"],
      gaps: [],
      client_request_id: randomUUID(),
    });
    const handoff = await data(service, "get_review_handoff", {
      note_id: main.id,
      related_note_ids: [related.id],
      review_ids: [review.id],
      feedback_note_ids: [feedback.id],
      include_sources: true,
      method_intent: "heijin_review",
    });
    assert.deepEqual(handoff.related_notes.map((item: any) => item.id), [related.id]);
    assert.deepEqual(handoff.reviews.map((item: any) => item.id), [review.id]);
    assert.deepEqual(handoff.feedback_notes.map((item: any) => item.id), [feedback.id]);
    assert.ok(!handoff.feedback_notes.some((item: any) => item.id === unselectedFeedback.id));
    const expectedRef = topic.blocks.flatMap((block: any) => block.source_refs ?? [])[0];
    assert.ok(expectedRef);
    assert.ok(handoff.source_refs.some((ref: any) => ref.source_block_id === expectedRef.source_block_id));
    assert.equal(handoff.source_summary.total_refs, handoff.source_refs.length);
    assert.equal(handoff.source_summary.attached_count, handoff.source_excerpts.length);
    assert.equal(handoff.selected.method_intent, "heijin_review");
    assert.equal(handoff.capabilities.receiver_capability, "verify_on_receiver");
    await rejects(service, "get_review_handoff", {
      note_id: main.id,
      review_ids: [review.id],
    }, "VALIDATION_ERROR");
  });
});

test("B04: bound course comparison preserves unchanged text and reports edits, removed conditions/blocks, added examples, changed refs and removed topics", async () => {
  await withService(async (service) => {
    const { course, topics, sourceBlocks } = await seedCourse(service);
    const baseTopics = topics.map(schemaTopic);
    const submitAndCompare = async (nextTopics: any[], request: string) => {
      const draft = await data(service, "submit_course_draft", courseDraft(course, nextTopics, sourceBlocks, request));
      const comparison = await data(service, "get_draft_comparison", { draft_id: draft.id });
      assert.equal(comparison.ready, true);
      assert.equal(comparison.draft_id, draft.id);
      assert.equal(comparison.draft_revision, draft.revision);
      assert.equal(comparison.current_revision, course.revision);
      assert.ok(comparison.current_topics.every((topic: any) => Array.isArray(topic.blocks) && topic.blocks.length > 0));
      assert.ok(comparison.proposed_topics.every((topic: any) => Array.isArray(topic.blocks)));
      return { draft, comparison, changes: comparableChanges(comparison) };
    };

    const unchanged = await submitAndCompare(baseTopics, "demo-b04-unchanged");
    assert.equal(unchanged.changes.filter((item: any) => item.kind === "added" || item.kind === "removed").length, 0);
    assert.equal(unchanged.changes.filter((item: any) => item.kind === "changed" && item.area.includes("讲义")).length, 0);

    const multiBlockTopic = baseTopics.find((topic: any) => topic.blocks.length >= 2);
    assert.ok(multiBlockTopic, "fixture needs a topic with at least two source-backed blocks");
    const conditionTopic = baseTopics.find((topic: any) => topic.blocks.some((block: any) => block.body_md.includes("仅当条件成立")));
    assert.ok(conditionTopic, `fixture keeps a condition sentence; topics=${JSON.stringify(baseTopics.map((topic: any) => topic.blocks.map((block: any) => block.body_md)))}`);
    const conditionBlock = conditionTopic.blocks.find((block: any) => block.body_md.includes("仅当条件成立"));
    assert.ok(conditionBlock);
    const changedPhrase = structuredClone(baseTopics);
    const changedTarget = changedPhrase.find((topic: any) => topic.id === conditionTopic.id);
    assert.ok(changedTarget);
    const changedBlock = changedTarget.blocks.find((block: any) => block.id === conditionBlock.id);
    assert.ok(changedBlock);
    changedBlock.body_md = "执行这项合成规则。";
    const changed = await submitAndCompare(changedPhrase, "demo-b04-changed-condition");
    const changedEntry = changed.changes.find((item: any) => item.kind === "changed" && item.title === conditionBlock.id);
    assert.ok(changedEntry);
    assert.ok(changedEntry.details.some((detail: string) => detail.includes("仅当条件成立")));
    assert.ok(changedEntry.details.some((detail: string) => detail.includes("条件或限制发生移除")));

    const removedBlockTopics = structuredClone(baseTopics);
    const removeTarget = removedBlockTopics.find((topic: any) => topic.id === multiBlockTopic.id);
    assert.ok(removeTarget);
    const removedBlock = removeTarget.blocks.pop();
    assert.ok(removedBlock);
    const removedBlockResult = await submitAndCompare(removedBlockTopics, "demo-b04-remove-block");
    assert.ok(removedBlockResult.changes.some((item: any) => item.kind === "removed" && item.title === removedBlock.id));

    const aiTopics = structuredClone(baseTopics);
    aiTopics[0].blocks.push({
      id: "tb_demo_ai_example",
      type: "example",
      body_md: "DEMO clearly labelled AI example.",
      origin_kind: "ai_assisted",
      transformation: "ai_example",
      source_refs: [],
      verification_status: "needs_review",
    });
    const addedExample = await submitAndCompare(aiTopics, "demo-b04-add-example");
    assert.ok(addedExample.changes.some((item: any) => item.kind === "added" && item.title === "tb_demo_ai_example"));

    const refTopics = structuredClone(baseTopics);
    const refBlock = refTopics[0].blocks[0];
    assert.ok(refBlock);
    const originalRef = refBlock.source_refs[0];
    assert.ok(originalRef);
    const alternate = sourceBlocks.find((block: any) => block.id !== originalRef.source_block_id);
    assert.ok(alternate);
    refBlock.source_refs = [{ source_document_id: alternate.source_document_id, source_version_id: alternate.source_version_id, source_block_id: alternate.id }];
    const changedRef = await submitAndCompare(refTopics, "demo-b04-change-ref");
    assert.ok(changedRef.changes.some((item: any) => item.kind === "changed" && item.details.some((detail: string) => detail.startsWith("出处："))));

    const removedTopicTopics = structuredClone(baseTopics).slice(0, 1);
    const removedTopic = await submitAndCompare(removedTopicTopics, "demo-b04-remove-topic");
    assert.ok(removedTopic.changes.some((item: any) => item.kind === "removed" && item.area === "主题"));
  });
});

test("B04: course adoption requires a current comparison token and rejects a stale snapshot", async () => {
  await withService(async (service) => {
    const { course, topics, sourceBlocks } = await seedCourse(service);
    const draft = await data(service, "submit_course_draft", courseDraft(course, topics, sourceBlocks, "demo-b04-token"));
    const comparison = await data(service, "get_draft_comparison", { draft_id: draft.id });
    await rejects(service, "review_draft", { draft_id: draft.id, action: "accept", expected_revision: draft.revision }, "REVISION_CONFLICT");
    const topic = service.store.get("topics", comparison.current_topics[0].id)!;
    service.store.put("topics", { ...topic, title: "DEMO concurrently changed topic" }, topic.revision);
    await rejects(service, "review_draft", {
      draft_id: draft.id,
      action: "accept",
      expected_revision: draft.revision,
      comparison_token: comparison.comparison_token,
    }, "REVISION_CONFLICT");
  });
});
