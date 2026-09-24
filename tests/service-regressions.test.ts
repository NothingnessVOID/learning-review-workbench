import { comparedReviewArgs } from "./review-args.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { splitSource } from "../src/domain/files.js";
import { Service } from "../src/domain/service.js";

type Actor = "local_user" | "external_agent";
type Rpc = {
  ok: boolean;
  data?: any;
  error?: { code: string; message: string };
};
const projectDir = process.cwd();
const sourceText =
  "# DEMO 回归课程\n\n## 主题一\n\nDEMO 原文段落一。\n\n## 主题二\n\nDEMO 原文段落二。\n";

async function fixture(run: (service: Service) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "learning-workbench-regression-"));
  const service = new Service(dir, projectDir);
  try {
    await run(service);
  } finally {
    service.store.close();
    await rm(dir, { recursive: true, force: true });
  }
}
async function invoke(
  service: Service,
  tool: string,
  args: unknown = {},
  actor: Actor = "local_user",
): Promise<Rpc> {
  return (await service.invoke(tool, args, actor)) as Rpc;
}
async function data(
  service: Service,
  tool: string,
  args: unknown = {},
  actor: Actor = "local_user",
) {
  const checkedArgs = await comparedReviewArgs(service, tool, args, actor);
  const result = await invoke(service, tool, checkedArgs, actor);
  assert.equal(result.ok, true, `${tool}: ${JSON.stringify(result.error)}`);
  return result.data;
}
async function error(
  service: Service,
  tool: string,
  args: unknown,
  code: string,
  actor: Actor = "local_user",
) {
  const result = await invoke(service, tool, args, actor);
  assert.equal(result.ok, false, `${tool} unexpectedly succeeded`);
  assert.equal(
    result.error?.code,
    code,
    `${tool} returned wrong error: ${JSON.stringify(result.error)}`,
  );
}
const upload = (name: string, value: string) => ({
  name,
  content_base64: Buffer.from(value).toString("base64"),
});
async function importedCourse(service: Service) {
  const preview = await data(service, "preview_import", {
    files: [upload("DEMO_regression.md", sourceText)],
    source_kind: "cleaned_transcript",
    series: "DEMO",
  });
  await data(service, "commit_import", { preview_id: preview.id });
  const listed = await data(service, "list_courses");
  const summary = listed.items.find((x: any) =>
    x.title.includes("DEMO 回归课程"),
  );
  const course = await data(service, "get_course", { course_id: summary.id });
  const excerpt = await data(service, "get_source_excerpt", {
    source_version_id: course.source_version_ids[0],
    limit: 20,
  });
  return { course, blocks: excerpt.blocks };
}
function draftFor(course: any, blocks: any[]) {
  const topic = course.topics[0];
  const refs = blocks.map((b) => ({
    source_document_id: b.source_document_id,
    source_version_id: b.source_version_id,
    source_block_id: b.id,
  }));
  return {
    course_id: course.id,
    title: course.title,
    series: course.series,
    overview: "DEMO 回归草稿。",
    expected_revision: course.revision,
    source_version_ids: course.source_version_ids,
    topics: [
      {
        id: topic.id,
        title: topic.title,
        parent_id: null,
        order: 0,
        content_kind: "main_teaching",
        revision: topic.revision,
        blocks: [
          {
            type: "explanation",
            body_md: "DEMO 根据来源整理。",
            origin_kind: "course_material",
            transformation: "ai_paraphrase",
            source_refs: refs,
          },
        ],
      },
    ],
    coverage: blocks.map((b) => ({
      source_block_id: b.id,
      disposition: "included",
      topic_ids: [topic.id],
    })),
    client_request_id: "demo-regression-course-draft",
  };
}

test("R05: accepting a course draft rechecks topic ownership and revision in the transaction", async () => {
  await fixture(async (service) => {
    const { course, blocks } = await importedCourse(service);
    const draft = await data(
      service,
      "submit_course_draft",
      draftFor(course, blocks),
    );
    const topic = service.store.get("topics", draft.payload.topics[0].id)!;
    service.store.put(
      "topics",
      { ...topic, title: "DEMO concurrent edit" },
      topic.revision,
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
    assert.notEqual(
      service.store.get("courses", course.id)!.revision,
      course.revision + 1,
      "failed accept must not partially write course",
    );
  });
});

test("R05 legacy V1 drafts reconstruct topic revisions from revision history", async () => {
  await fixture(async (service) => {
    const { course, blocks } = await importedCourse(service);
    const draft = await data(
      service,
      "submit_course_draft",
      draftFor(course, blocks),
    );
    const stored = service.store.get("drafts", draft.id)!;
    delete stored.topic_revisions;
    service.store.db
      .prepare("UPDATE drafts SET data=? WHERE id=?")
      .run(JSON.stringify(stored), draft.id);
    const accepted = await data(service, "review_draft", {
      draft_id: draft.id,
      action: "accept",
      expected_revision: draft.revision,
    });
    assert.equal(accepted.status, "accepted");
  });
});

test("M03 rejects unknown coverage dispositions and topicless main teaching", async () => {
  await fixture(async (service) => {
    const { course, blocks } = await importedCourse(service);
    const draft = draftFor(course, blocks);
    await error(
      service,
      "submit_course_draft",
      {
        ...draft,
        client_request_id: "demo-bad-disposition",
        coverage: draft.coverage.map((x: any) => ({
          ...x,
          disposition: "lost",
        })),
      },
      "VALIDATION_ERROR",
    );
    await error(
      service,
      "submit_course_draft",
      {
        ...draft,
        client_request_id: "demo-no-destination",
        coverage: draft.coverage.map((x: any) => ({
          ...x,
          disposition: "main_teaching",
          topic_ids: [],
        })),
      },
      "VALIDATION_ERROR",
    );
  });
});

test("M03 keeps source quotations and AI examples as separate teaching block types", async () => {
  await fixture(async (service) => {
    const { course, blocks } = await importedCourse(service);
    const draft = draftFor(course, blocks);
    const topic = draft.topics[0];
    const originalRef = topic.blocks[0].source_refs[0];
    const invalidMixedBlock = {
      ...topic.blocks[0],
      type: "source_quote",
      transformation: "ai_example",
      source_refs: [],
    };
    await error(
      service,
      "submit_course_draft",
      {
        ...draft,
        client_request_id: "demo-reject-mixed-source-quote",
        topics: [{ ...topic, blocks: [invalidMixedBlock] }],
      },
      "VALIDATION_ERROR",
    );

    const separateBlocks = [
      {
        id: "demo-original-quote",
        type: "source_quote",
        body_md: "DEMO 原文引用段落。",
        origin_kind: "course_material",
        transformation: "direct_quote",
        source_refs: [originalRef],
      },
      {
        id: "demo-ai-example",
        type: "example",
        body_md: "DEMO AI 补充示例，需与原文区分。",
        origin_kind: "ai_assisted",
        transformation: "ai_example",
        source_refs: [],
      },
    ];
    const accepted = await data(service, "submit_course_draft", {
      ...draft,
      client_request_id: "demo-accept-separated-quote-example",
      topics: [{ ...topic, blocks: separateBlocks }],
    });
    assert.equal(accepted.entity_type, "course");
    assert.equal(
      accepted.payload.topics[0].blocks[0].transformation,
      "direct_quote",
    );
    assert.equal(
      accepted.payload.topics[0].blocks[1].transformation,
      "ai_example",
    );
  });
});

test("U03 maps same-package source and topic temporary IDs with an explainable result", async () => {
  await fixture(async (service) => {
    const text = "# DEMO package source\n\n## Lesson\n\nDEMO body.\n";
    const temporaryBlocks = splitSource(text, "tmp_version", "tmp_document");
    const packageData = {
      schema_version: "1.0.0",
      kind: "learning_workbench_import",
      sources: [
        {
          path: "source.md",
          source_document_id: "tmp_document",
          source_version_id: "tmp_version",
          blocks: temporaryBlocks.map((b) => ({ id: b.id, order: b.order })),
        },
      ],
      courses: [
        {
          course_id: "temp_course_lesson",
          title: "DEMO mapped course",
          series: "DEMO",
          overview: "DEMO package mapping.",
          expected_revision: 0,
          source_version_ids: ["tmp_version"],
          topics: [
            {
              id: "temp_topic_lesson",
              content_identity: "lesson-one",
              title: "Lesson",
              parent_id: null,
              order: 0,
              content_kind: "main_teaching",
              blocks: [
                {
                  type: "explanation",
                  body_md: "DEMO mapped lesson.",
                  origin_kind: "course_material",
                  transformation: "ai_paraphrase",
                  source_refs: temporaryBlocks.map((b) => ({
                    source_document_id: "tmp_document",
                    source_version_id: "tmp_version",
                    source_block_id: b.id,
                  })),
                },
              ],
            },
          ],
          coverage: temporaryBlocks.map((b) => ({
            source_block_id: b.id,
            disposition: "main_teaching",
            topic_ids: ["temp_topic_lesson"],
          })),
        },
      ],
      knowledge: [
        {
          title: "DEMO mapped card",
          type: "concept",
          body_md: "DEMO reusable card.",
          source_refs: [],
          topic_ids: ["temp_topic_lesson"],
          expected_revision: 0,
        },
      ],
    };
    const preview = await data(service, "preview_import", {
      files: [
        upload("manifest.json", JSON.stringify(packageData)),
        upload("source.md", text),
      ],
    });
    assert.ok(
      preview.mapping_preview.some(
        (x: any) =>
          x.kind === "topic" &&
          x.match_method === "unique content_identity at draft submission",
      ),
      JSON.stringify(preview.mapping_preview),
    );
    const committed = await data(service, "commit_import", {
      preview_id: preview.id,
    });
    const courseDraft = committed.drafts.find(
      (x: any) => x.entity_type === "course",
    );
    const cardDraft = committed.drafts.find(
      (x: any) => x.entity_type === "knowledge",
    );
    assert.ok(courseDraft && cardDraft);
    assert.notEqual(courseDraft.entity_id, "temp_course_lesson");
    assert.notEqual(courseDraft.payload.topics[0].id, "temp_topic_lesson");
    assert.equal(
      cardDraft.payload.topic_ids[0],
      courseDraft.payload.topics[0].id,
    );
    assert.ok(
      committed.mappings.some(
        (x: any) =>
          x.kind === "source_ref" &&
          x.temporary_id.startsWith("blk_tmp_version"),
      ),
    );
    await error(
      service,
      "review_draft",
      {
        draft_id: cardDraft.id,
        action: "accept",
        expected_revision: cardDraft.revision,
      },
      "REVISION_CONFLICT",
    );
    const acceptedCourse = await data(service, "review_draft", {
      draft_id: courseDraft.id,
      action: "accept",
      expected_revision: courseDraft.revision,
    });
    assert.equal(acceptedCourse.status, "accepted");
    const acceptedCard = await data(service, "review_draft", {
      draft_id: cardDraft.id,
      action: "accept",
      expected_revision: cardDraft.revision,
    });
    assert.equal(acceptedCard.status, "accepted");
  });
});

test("U05 date filters include the whole selected day and notes paginate by occurred_at", async () => {
  await fixture(async (service) => {
    for (const [i, occurred_at] of [
      "2026-08-31T23:59:59+08:00",
      "2026-09-01T12:00:00+08:00",
      "2026-09-01T23:59:59+08:00",
      "2026-09-02T10:00:00+08:00",
    ].entries())
      await data(service, "create_note", {
        original_text: `DEMO dated note ${i}`,
        occurred_at,
        client_request_id: `demo-date-${i}`,
      });
    const page1 = await data(service, "list_notes", {
      from: "2026-09-01",
      to: "2026-09-01",
      limit: 1,
    });
    assert.equal(page1.total, 2);
    assert.ok(page1.next_cursor);
    const page2 = await data(service, "list_notes", {
      from: "2026-09-01",
      to: "2026-09-01",
      limit: 1,
      cursor: Number(page1.next_cursor),
    });
    assert.equal(page2.items.length, 1);
    assert.equal(page1.items[0].id === page2.items[0].id, false);
    await error(
      service,
      "list_notes",
      { from: "2026-02-30", to: "2026-09-01" },
      "VALIDATION_ERROR",
    );
  });
});

test("U06 default search includes cases/reviews but never crosses note permissions", async () => {
  await fixture(async (service) => {
    const first = await data(service, "create_note", {
      original_text: "DEMO selected note",
      client_request_id: "demo-private-a",
    });
    const second = await data(service, "create_note", {
      original_text: "DEMO hidden note",
      client_request_id: "demo-private-b",
    });
    const review = service.store.put(
      "reviews",
      {
        id: "review_demo_private",
        note_ids: [first.id, second.id],
        body_md: "DEMO shared review needle",
      },
      0,
    );
    service.store.put(
      "cases",
      {
        id: "case_demo_public",
        description: "DEMO public case needle",
        permission: "library",
        source_identity: "DEMO source",
      },
      0,
    );
    service.store.put(
      "cases",
      {
        id: "case_demo_private",
        description: "DEMO hidden case needle",
        permission: "library",
        note_id: second.id,
        source_identity: "DEMO source",
      },
      0,
    );
    await data(service, "set_permissions", {
      permissions: {
        read_library: true,
        append_notes: false,
        save_reviews: false,
        submit_courses: false,
        submit_knowledge: false,
        propose_relations: false,
        read_note_ids: [first.id],
      },
    });
    const reviewHits = await data(
      service,
      "search_library",
      { query: "shared review needle" },
      "external_agent",
    );
    assert.ok(!reviewHits.items.some((x: any) => x.id === review.id));
    const caseHits = await data(
      service,
      "search_library",
      { query: "case needle" },
      "external_agent",
    );
    assert.ok(caseHits.items.some((x: any) => x.id === "case_demo_public"));
    assert.ok(!caseHits.items.some((x: any) => x.id === "case_demo_private"));
  });
});

test("M01 large detail preserves complete text or gives an explicit error", async () => {
  await fixture(async (service) => {
    const { course, blocks } = await importedCourse(service);
    const topic = course.topics[0];
    const long = "DEMO full lesson text ".repeat(5000);
    service.store.put(
      "topics",
      {
        ...service.store.get("topics", topic.id)!,
        blocks: [{ type: "explanation", body_md: long, source_refs: [] }],
      },
      topic.revision,
    );
    const response = await data(service, "get_topic", { topic_id: topic.id });
    assert.equal(response.blocks[0].body_md, long);
    assert.equal(response.content_truncated, undefined);
    assert.ok(blocks.length > 0);
  });
});

test("U09 handoff includes only explicitly selected notes and sources", async () => {
  await fixture(async (service) => {
    const { course } = await importedCourse(service);
    const topic = course.topics[0];
    const original = await data(service, "create_note", {
      original_text: "DEMO original event",
      relation_ids: [topic.id],
      client_request_id: "demo-handoff-a",
    });
    const selected = await data(service, "create_note", {
      original_text: "DEMO selected related event",
      client_request_id: "demo-handoff-b",
    });
    await data(service, "create_note", {
      original_text: "DEMO unselected event",
      client_request_id: "demo-handoff-c",
    });
    const handoff = await data(service, "get_review_handoff", {
      note_id: original.id,
      related_note_ids: [selected.id],
      include_sources: true,
    });
    assert.equal(handoff.related_notes.length, 1);
    assert.equal(handoff.related_notes[0].id, selected.id);
    assert.ok(handoff.source_excerpts.length > 0);
    assert.ok(handoff.gaps.length > 0);
    assert.equal(handoff.capabilities.method_context_available, false);
    await error(
      service,
      "get_review_handoff",
      { note_id: original.id },
      "PERMISSION_DENIED",
      "external_agent",
    );
  });
});
