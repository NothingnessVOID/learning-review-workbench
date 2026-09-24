import assert from "node:assert/strict";
import { test } from "node:test";
import { readableChanges } from "../src/web/diff.js";
import { sameSubmittedDraft } from "../src/web/drafts.js";
import {
  handoffMarkdown,
  sameHandoffSelection,
  type HandoffResult,
  type HandoffSelection,
} from "../src/web/handoff.js";
import { changeReviewLinks, reviewNoteIds } from "../src/web/review-draft.js";

const selection: HandoffSelection = {
  note_id: "note_main",
  related_note_ids: ["note_chosen"],
  review_ids: ["review_old"],
  feedback_note_ids: ["note_feedback"],
  include_sources: true,
  method_intent: "heijin_review",
};

const result = {
  note: {
    id: "note_main",
    original_text: "原话 A",
    occurred_at: "2026-09-23T16:10:00Z",
    created_at: "2026-09-24T10:00:00Z",
  },
  related_notes: [
    {
      id: "note_chosen",
      original_text: "原话 B",
      occurred_at: null,
      created_at: "2026-09-22T10:00:00Z",
    },
  ],
  reviews: [
    {
      id: "review_old",
      body_md: "先前复盘",
      created_at: "2026-09-24T11:00:00Z",
      method_name: "方法",
    },
  ],
  feedback_notes: [
    {
      id: "note_feedback",
      original_text: "后来执行",
      occurred_at: null,
      created_at: "2026-09-25T10:00:00Z",
    },
  ],
  source_refs: [
    {
      source_document_id: "doc_1",
      source_version_id: "sv_1",
      source_block_id: "blk_1",
    },
    {
      source_document_id: "doc_2",
      source_version_id: "sv_2",
      source_block_id: "blk_2",
    },
  ],
  source_excerpts: [
    {
      source_document_id: "doc_1",
      source_version_id: "sv_1",
      source_block_id: "blk_1",
      text: "原文摘录",
      source_name: "资料一",
      block_order: 3,
      line_start: 7,
      line_end: 9,
      content_truncated: true,
    },
  ],
  source_summary: {
    total_refs: 2,
    attached_count: 1,
    omitted_refs: [
      {
        source_document_id: "doc_2",
        source_version_id: "sv_2",
        source_block_id: "blk_2",
      },
    ],
    truncated_refs: [
      {
        source_document_id: "doc_1",
        source_version_id: "sv_1",
        source_block_id: "blk_1",
      },
    ],
  },
  gaps: ["接收端须自行核验方法"],
  selected: { ...selection },
} as unknown as HandoffResult;

test("B03 handoff selection rejects a response after any selected scope changes", () => {
  assert.equal(sameHandoffSelection(selection, result), true);
  assert.equal(
    sameHandoffSelection({ ...selection, related_note_ids: [] }, result),
    false,
  );
  assert.equal(
    sameHandoffSelection({ ...selection, include_sources: false }, result),
    false,
  );
  assert.equal(
    sameHandoffSelection(
      { ...selection, method_intent: "general_review" },
      result,
    ),
    false,
  );
  assert.equal(
    sameHandoffSelection({ ...selection, note_id: "note_other" }, result),
    false,
  );
});

test("B06 handoff text keeps time, selected context and fixed source omissions", () => {
  const text = handoffMarkdown(result, selection);
  assert.match(text, /发生时间：2026-09-23T16:10:00Z/);
  assert.match(text, /写入时间：2026-09-24T10:00:00Z/);
  assert.match(text, /发生时间：未记录/);
  assert.match(text, /先前复盘/);
  assert.match(text, /后来执行/);
  assert.match(text, /doc_1 \/ sv_1 \/ blk_1/);
  assert.match(text, /doc_2 \/ sv_2 \/ blk_2/);
  assert.match(text, /区段序号 3 · 行 7–9/);
  assert.match(text, /此段已截断/);
  assert.match(text, /未附来源/);
  assert.match(text, /接收 Agent 是否具备对应 Skill.*实际核验/);
});

test("B04 readable diff uses full old blocks to identify removed conditions", () => {
  const oldCourse = {
    id: "course_1",
    title: "课程",
    topics: [
      {
        id: "topic_1",
        title: "主题",
        blocks: [
          { id: "tb_keep", body_md: "保留的正文" },
          { id: "tb_remove", body_md: "只有实际行动，才进入下一步。" },
        ],
      },
    ],
  };
  const proposedCourse = {
    ...oldCourse,
    topics: [
      {
        id: "topic_1",
        title: "主题",
        blocks: [{ id: "tb_keep", body_md: "保留的正文" }],
      },
    ],
  };
  const changes = readableChanges(oldCourse, proposedCourse, "course");
  assert.ok(
    changes.some(
      (change) => change.kind === "removed" && change.title === "tb_remove",
    ),
  );
  assert.ok(
    !changes.some(
      (change) => change.kind === "added" && change.title === "tb_keep",
    ),
  );
});

test("B06 changing related notes while review A saves creates version B with its own link snapshot", () => {
  const draftA = {
    text: "复盘正文",
    linkSelectedNotes: true,
    linkedNoteIds: ["note_a"],
    requestId: "request_a",
  };
  const draftB = changeReviewLinks(draftA, ["note_b"], true, "request_b");
  assert.deepEqual(reviewNoteIds("note_main", draftA), ["note_main", "note_a"]);
  assert.deepEqual(reviewNoteIds("note_main", draftB), ["note_main", "note_b"]);
  assert.notEqual(draftA.requestId, draftB.requestId);
  assert.equal(sameSubmittedDraft(draftB, draftA), false);
  const between = changeReviewLinks(draftA, [], true, "request_between");
  assert.equal(between.linkSelectedNotes, true);
  const selectedAgain = changeReviewLinks(
    between,
    ["note_b"],
    true,
    "request_b2",
  );
  assert.deepEqual(reviewNoteIds("note_main", selectedAgain), [
    "note_main",
    "note_b",
  ]);
  const cleared = changeReviewLinks(draftB, [], false, "request_c");
  assert.deepEqual(reviewNoteIds("note_main", cleared), ["note_main"]);
});
