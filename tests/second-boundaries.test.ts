import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Service } from "../src/domain/service.js";

const appVersion = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;

async function fixture(run: (service: Service) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "workbench-second-boundaries-"));
  const service = new Service(dir, process.cwd());
  try {
    await run(service);
  } finally {
    service.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
async function call(
  service: Service,
  tool: string,
  args: object = {},
  actor: "local_user" | "external_agent" = "local_user",
) {
  return service.invoke(tool, args, actor);
}
async function data(
  service: Service,
  tool: string,
  args: object = {},
  actor: "local_user" | "external_agent" = "local_user",
) {
  const response = await call(service, tool, args, actor);
  assert.equal(response.ok, true, `${tool}: ${JSON.stringify(response.error)}`);
  return response.data as any;
}
async function error(
  service: Service,
  tool: string,
  args: object,
  code: string,
  actor: "local_user" | "external_agent" = "local_user",
) {
  const response = await call(service, tool, args, actor);
  assert.equal(response.ok, false, `${tool} unexpectedly succeeded`);
  assert.equal(response.error?.code, code);
}
async function sourceCourse(
  service: Service,
  name = "DEMO-second.md",
  text = "# DEMO course\n\n## One\n\nA lesson.\n\n## Two\n\nAnother lesson.\n",
) {
  const preview = await data(service, "preview_import", {
    files: [{ name, content_base64: Buffer.from(text).toString("base64") }],
    source_kind: "other",
  });
  const committed = await data(service, "commit_import", {
    preview_id: preview.id,
  });
  const course = await data(service, "get_course", {
    course_id: committed.imported[0].course_id,
  });
  const topics = await Promise.all(
    course.topics.map((topic: any) =>
      data(service, "get_topic", { topic_id: topic.id }),
    ),
  );
  return { course, topics, imported: committed.imported[0] };
}
const grant = (
  service: Service,
  read_library: boolean,
  read_note_ids: string[],
) =>
  service.store.setting("permissions", {
    read_library,
    read_note_ids,
    append_notes: false,
    save_reviews: false,
    submit_courses: false,
    submit_knowledge: false,
    propose_relations: false,
  });

test("B01 anchors validate teaching blocks in their selected topic and expose stable legacy IDs", async () => {
  await fixture(async (service) => {
    const first = await sourceCourse(service);
    const second = await sourceCourse(
      service,
      "DEMO-other.md",
      "# Other course\n\n## Separate\n\nOther text.\n",
    );
    const [one, two] = first.topics
      .filter((topic: any) => topic.blocks.length)
      .slice(0, 2);
    const foreign = second.topics.find((topic: any) => topic.blocks.length);
    assert(one && two && foreign);
    const saved = await data(service, "set_learning_state", {
      object_id: first.course.id,
      position: {
        topic_id: one.id,
        teaching_block_id: one.blocks[0].id,
        scroll: 42,
      },
    });
    assert.equal(saved.position.teaching_block_id, one.blocks[0].id);
    await error(
      service,
      "set_learning_state",
      {
        object_id: first.course.id,
        position: { topic_id: one.id, teaching_block_id: two.blocks[0].id },
      },
      "SOURCE_REF_INVALID",
    );
    await error(
      service,
      "set_learning_state",
      {
        object_id: first.course.id,
        position: {
          topic_id: foreign.id,
          teaching_block_id: foreign.blocks[0].id,
        },
      },
      "SOURCE_REF_INVALID",
    );
    await error(
      service,
      "set_learning_state",
      {
        object_id: first.course.id,
        position: { topic_id: one.id, teaching_block_id: "tb_random_demo" },
      },
      "SOURCE_REF_INVALID",
    );
    const sourceBlockId = one.blocks[0].source_refs?.[0]?.source_block_id;
    if (sourceBlockId) {
      const legacy = await data(service, "set_learning_state", {
        object_id: first.course.id,
        position: { topic_id: one.id, block_id: sourceBlockId },
      });
      assert.equal(legacy.position.teaching_block_id, one.blocks[0].id);
    }
    const raw = service.store.get("topics", one.id)!;
    service.store.put(
      "topics",
      {
        ...raw,
        blocks: raw.blocks.map((block: any) => {
          const { id, ...rest } = block;
          return rest;
        }),
      },
      raw.revision,
    );
    const firstRead = await data(service, "get_topic", { topic_id: one.id });
    const secondRead = await data(service, "get_topic", { topic_id: one.id });
    assert.match(firstRead.blocks[0].id, /^tb_legacy_/);
    assert.equal(firstRead.blocks[0].id, secondRead.blocks[0].id);
    assert.equal(
      service.store.get("topics", one.id)!.blocks[0].id,
      undefined,
      "read-only IDs must not mutate old data",
    );
  });
});

test("B04 comparison carries complete old/new blocks and rejects absent, forged, or stale tokens", async () => {
  await fixture(async (service) => {
    const { course, topics } = await sourceCourse(service);
    const current = topics.find((topic: any) => topic.blocks.length);
    assert(current);
    const payload = {
      title: course.title,
      overview: course.overview ?? "",
      source_version_ids: course.source_version_ids,
      topics: topics.map((topic: any) => ({ ...topic, blocks: topic.blocks })),
      coverage: [],
      unresolved_questions: [],
    };
    const draft = service.store.put(
      "drafts",
      {
        id: "draft_comparison_demo",
        entity_type: "course",
        entity_id: course.id,
        status: "draft",
        expected_revision: course.revision,
        payload,
        topic_revisions: Object.fromEntries(
          topics.map((topic: any) => [topic.id, topic.revision]),
        ),
      },
      0,
    );
    const comparison = await data(service, "get_draft_comparison", {
      draft_id: draft.id,
    });
    assert.equal(comparison.ready, true);
    assert.equal(comparison.current_revision, course.revision);
    assert.equal(
      comparison.current_topics.find((topic: any) => topic.id === current.id)
        .blocks.length,
      current.blocks.length,
    );
    assert.equal(
      comparison.proposed_topics.find((topic: any) => topic.id === current.id)
        .blocks.length,
      current.blocks.length,
    );
    await error(
      service,
      "review_draft",
      {
        draft_id: draft.id,
        action: "accept",
        expected_revision: draft.revision,
      },
      "REVISION_CONFLICT",
    );
    await error(
      service,
      "review_draft",
      {
        draft_id: draft.id,
        action: "accept",
        expected_revision: draft.revision,
        comparison_token: "0".repeat(64),
      },
      "REVISION_CONFLICT",
    );
    service.store.put(
      "drafts",
      {
        id: "draft_unrelated_demo",
        entity_type: "knowledge",
        entity_id: "card_unrelated",
        status: "draft",
        payload: { title: "Other" },
      },
      0,
    );
    assert.equal(
      (await data(service, "get_draft_comparison", { draft_id: draft.id }))
        .comparison_token,
      comparison.comparison_token,
    );
    const changed = service.store.get("topics", current.id)!;
    service.store.put(
      "topics",
      { ...changed, title: "Changed after comparison" },
      changed.revision,
    );
    await error(
      service,
      "review_draft",
      {
        draft_id: draft.id,
        action: "accept",
        expected_revision: draft.revision,
        comparison_token: comparison.comparison_token,
      },
      "REVISION_CONFLICT",
    );
    const huge = service.store.put(
      "drafts",
      {
        id: "draft_huge_demo",
        entity_type: "course",
        entity_id: "course_new_huge",
        status: "draft",
        expected_revision: 0,
        payload: {
          title: "Huge",
          topics: [
            {
              id: "topic_huge",
              blocks: [{ type: "explanation", body_md: "大".repeat(750000) }],
            },
          ],
        },
      },
      0,
    );
    await error(
      service,
      "get_draft_comparison",
      { draft_id: huge.id },
      "PAYLOAD_TOO_LARGE",
    );
  });
});

test("B05 confirmed links appear from both ends, while pending/rejected/private links stay scoped", async () => {
  await fixture(async (service) => {
    const { course, topics } = await sourceCourse(service);
    const topic = topics.reduce((largest: any, item: any) =>
      item.blocks.length > (largest?.blocks.length ?? 0) ? item : largest,
    );
    const note = service.store.put(
      "notes",
      {
        id: "note_linked_demo",
        original_text: "DEMO linked",
        type: "quick",
        relation_ids: [],
      },
      0,
    );
    const pending = service.store.put(
      "relations",
      {
        id: "relation_pending_demo",
        from_id: note.id,
        to_id: topic.id,
        kind: "related",
        status: "pending",
      },
      0,
    );
    assert.equal(
      (await data(service, "get_topic", { topic_id: topic.id })).notes.length,
      0,
    );
    await data(service, "review_relation", {
      relation_id: pending.id,
      status: "confirmed",
    });
    assert.equal(
      (await data(service, "get_topic", { topic_id: topic.id })).notes.some(
        (n: any) => n.id === note.id,
      ),
      true,
    );
    assert.equal(
      (await data(service, "list_notes", { relation_id: topic.id })).items.some(
        (n: any) => n.id === note.id,
      ),
      true,
    );
    assert.equal(
      (
        await data(service, "get_note", { note_id: note.id })
      ).resolved_relations.some((r: any) => r.id === topic.id),
      true,
    );
    const handoff = await data(service, "get_review_handoff", {
      note_id: note.id,
      include_sources: true,
    });
    assert(handoff.source_summary.total_refs > 0);
    assert(
      handoff.source_excerpts.every(
        (ref: any) =>
          ref.source_document_id &&
          ref.source_version_id &&
          ref.source_block_id,
      ),
    );
    const rejected = service.store.put(
      "relations",
      {
        id: "relation_rejected_demo",
        from_id: note.id,
        to_id: course.id,
        kind: "related",
        status: "rejected",
      },
      0,
    );
    assert.equal(
      (await data(service, "list_notes", { relation_id: rejected.to_id })).items
        .length,
      0,
    );
    const incoming = service.store.put(
      "notes",
      {
        id: "note_incoming_demo",
        original_text: "DEMO incoming",
        type: "quick",
        relation_ids: [note.id],
      },
      0,
    );
    assert.equal(
      (
        await data(service, "get_note", { note_id: note.id })
      ).resolved_relations.some((r: any) => r.id === incoming.id),
      true,
    );
    service.store.put(
      "cases",
      {
        id: "case_private_demo",
        description: "DEMO private case",
        permission: "private",
      },
      0,
    );
    service.store.put(
      "relations",
      {
        id: "relation_private_case",
        from_id: note.id,
        to_id: "case_private_demo",
        kind: "related",
        status: "confirmed",
      },
      0,
    );
    service.store.put(
      "relations",
      {
        id: "relation_pending_private_case",
        from_id: note.id,
        to_id: "case_private_demo",
        kind: "related",
        status: "pending",
        reason: "DEMO private reason",
      },
      0,
    );
    service.store.put(
      "cases",
      {
        id: "case_library_demo",
        description: "DEMO public case",
        permission: "library",
        note_ids: [note.id],
      },
      0,
    );
    service.store.put(
      "relations",
      {
        id: "relation_library_case",
        from_id: note.id,
        to_id: "case_library_demo",
        kind: "related",
        status: "confirmed",
      },
      0,
    );
    const followup = service.store.put(
      "notes",
      {
        id: "note_followup_private_link_demo",
        original_text: "DEMO followup",
        type: "feedback",
        parent_note_id: note.id,
        relation_ids: ["case_private_demo"],
      },
      0,
    );
    grant(service, true, [note.id, followup.id]);
    const external = await data(
      service,
      "get_note",
      { note_id: note.id },
      "external_agent",
    );
    assert.equal(
      external.resolved_relations.some(
        (r: any) => r.id === "case_private_demo",
      ),
      false,
    );
    assert.equal(
      external.relations.some((r: any) => r.to_id === "case_private_demo"),
      false,
    );
    assert.deepEqual(external.followups[0].relation_ids, []);
    const visibleRelations = await data(
      service,
      "list_relations",
      {},
      "external_agent",
    );
    assert.equal(
      visibleRelations.items.some((r: any) => r.to_id === "case_private_demo"),
      false,
    );
    assert.equal(
      visibleRelations.items.some((r: any) => r.id === "relation_library_case"),
      true,
    );
    grant(service, true, []);
    const revokedRelations = await data(
      service,
      "list_relations",
      {},
      "external_agent",
    );
    assert.equal(
      revokedRelations.items.some((r: any) => r.id === "relation_library_case"),
      false,
    );
    await error(
      service,
      "get_note",
      { note_id: note.id },
      "PERMISSION_DENIED",
      "external_agent",
    );
  });
});

test("B06 handoff includes only selected reviews/feedback with fixed refs and explicit omission flags", async () => {
  await fixture(async (service) => {
    const long = `# DEMO long\n\n## One\n\n${Array.from({ length: 61 }, (_, i) => `Paragraph ${i} ${"x".repeat(i === 0 ? 12020 : 8000)}`).join("\n\n")}\n`;
    const { topics } = await sourceCourse(service, "DEMO-long.md", long);
    const topic = topics.reduce((largest: any, item: any) =>
      item.blocks.length > (largest?.blocks.length ?? 0) ? item : largest,
    );
    const note = service.store.put(
      "notes",
      {
        id: "note_handoff_demo",
        original_text: "DEMO original",
        type: "event",
        occurred_at: "2026-09-01T09:00:00+08:00",
        relation_ids: [topic.id],
      },
      0,
    );
    const related = service.store.put(
      "notes",
      {
        id: "note_related_demo",
        original_text: "DEMO related",
        type: "quick",
        relation_ids: [],
      },
      0,
    );
    const hidden = service.store.put(
      "notes",
      {
        id: "note_unselected_demo",
        original_text: "DEMO unselected",
        type: "quick",
        relation_ids: [],
      },
      0,
    );
    const feedback = service.store.put(
      "notes",
      {
        id: "note_feedback_demo",
        original_text: "DEMO action",
        type: "feedback",
        parent_note_id: note.id,
        relation_ids: [],
      },
      0,
    );
    const review = service.store.put(
      "reviews",
      {
        id: "review_selected_demo",
        note_ids: [note.id, related.id],
        body_md: "DEMO review",
      },
      0,
    );
    const invalid = service.store.put(
      "reviews",
      {
        id: "review_unselected_demo",
        note_ids: [note.id, hidden.id],
        body_md: "DEMO private review",
      },
      0,
    );
    await error(
      service,
      "get_review_handoff",
      {
        note_id: note.id,
        related_note_ids: [related.id],
        review_ids: [invalid.id],
      },
      "VALIDATION_ERROR",
    );
    const handoff = await data(service, "get_review_handoff", {
      note_id: note.id,
      related_note_ids: [related.id],
      review_ids: [review.id],
      feedback_note_ids: [feedback.id],
      include_sources: true,
      method_intent: "heijin_review",
    });
    assert.equal(handoff.note.occurred_at, "2026-09-01T09:00:00+08:00");
    assert.deepEqual(
      handoff.reviews.map((item: any) => item.id),
      [review.id],
    );
    assert.deepEqual(
      handoff.feedback_notes.map((item: any) => item.id),
      [feedback.id],
    );
    assert.equal(handoff.method_intent, "heijin_review");
    assert.equal(
      handoff.capabilities.receiver_capability,
      "verify_on_receiver",
    );
    assert(handoff.source_summary.total_refs > 50);
    assert.equal(handoff.source_excerpts.length, 10);
    assert.equal(handoff.source_refs.length, handoff.source_summary.total_refs);
    assert.equal(
      handoff.source_summary.omitted_refs.length,
      handoff.source_summary.total_refs - 10,
    );
    assert(handoff.source_summary.truncated_refs.length > 0);
    assert(
      handoff.source_excerpts[0].source_document_id &&
        handoff.source_excerpts[0].source_version_id &&
        handoff.source_excerpts[0].source_block_id,
    );
  });
});

test("B07/B08 list states and scoped case/review details remain reachable through shared tools", async () => {
  await fixture(async (service) => {
    const { course } = await sourceCourse(service);
    const listed = await data(service, "list_courses", {});
    assert.equal(
      listed.items.find((item: any) => item.id === course.id).processing_status,
      service.store.get("courses", course.id)!.processing_status,
    );
    const card = service.store.put(
      "cards",
      {
        id: "card_status_demo",
        title: "DEMO status",
        type: "concept",
        body_md: "DEMO",
        aliases: [],
        topic_ids: [],
        source_refs: [],
        verification_status: "source_locatable",
      },
      0,
    );
    const knowledge = await data(service, "list_knowledge", {});
    assert.equal(
      knowledge.items.find((item: any) => item.id === card.id)
        .verification_status,
      "source_locatable",
    );
    const first = service.store.put(
      "notes",
      {
        id: "note_review_one",
        original_text: "DEMO first",
        type: "quick",
        relation_ids: [],
      },
      0,
    );
    const second = service.store.put(
      "notes",
      {
        id: "note_review_two",
        original_text: "DEMO second",
        type: "quick",
        relation_ids: [],
      },
      0,
    );
    const review = service.store.put(
      "reviews",
      {
        id: "review_scoped_demo",
        note_ids: [first.id, second.id],
        body_md: "DEMO full review",
      },
      0,
    );
    const libraryCase = service.store.put(
      "cases",
      {
        id: "case_library_demo",
        description: "DEMO case",
        permission: "library",
        note_id: first.id,
      },
      0,
    );
    grant(service, false, [first.id, second.id]);
    assert.equal(
      (
        await data(
          service,
          "get_review_result",
          { review_id: review.id },
          "external_agent",
        )
      ).body_md,
      "DEMO full review",
    );
    await error(
      service,
      "get_case",
      { case_id: libraryCase.id },
      "PERMISSION_DENIED",
      "external_agent",
    );
    grant(service, true, [first.id]);
    await error(
      service,
      "get_review_result",
      { review_id: review.id },
      "PERMISSION_DENIED",
      "external_agent",
    );
    assert.equal(
      (
        await data(
          service,
          "get_case",
          { case_id: libraryCase.id },
          "external_agent",
        )
      ).id,
      libraryCase.id,
    );
    grant(service, true, [first.id, second.id]);
    assert.equal((await data(service, "get_status")).app_version, appVersion);
  });
});
