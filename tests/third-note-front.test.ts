import assert from "node:assert/strict";
import { test } from "node:test";
import {
  handoffMarkdown,
  type HandoffResult,
  type HandoffSelection,
} from "../src/web/handoff.js";
import { noteTimeline } from "../src/web/note-timeline.js";
import type { Note, Review } from "../src/web/types.js";

const selection: HandoffSelection = {
  note_id: "note_a",
  related_note_ids: [],
  review_ids: ["review_a"],
  feedback_note_ids: [],
  include_sources: false,
  method_intent: "general_review",
};

test("C04 selected review retains independent gaps and scoped basis", () => {
  const result = {
    note: { id: "note_a", original_text: "原话", created_at: "2026-01-01" },
    related_notes: [],
    feedback_notes: [],
    source_refs: [],
    source_excerpts: [],
    reviews: [
      {
        id: "review_a",
        note_ids: ["note_a"],
        body_md: "正文无待核声明",
        author_type: "external_agent",
        method_name: "方法",
        method_version: "v1",
        created_at: "2026-01-02",
        gaps: ["未核实独立字段"],
        basis: [
          "文本依据",
          {
            source_document_id: "doc",
            source_version_id: "v",
            source_block_id: "b",
            text: "不可直接夹带原文",
          },
          { note_id: "note_secret", text: "未选记录内容" },
        ],
      },
    ],
    gaps: ["通用缺口"],
    selected: selection,
  } as unknown as HandoffResult;
  const text = handoffMarkdown(result, selection);
  for (const part of [
    "未核实独立字段",
    "文本依据",
    "doc / v / b",
    "external_agent",
    "/#note/note_a",
    "方法 · v1",
    "通用缺口",
  ])
    assert.ok(text.includes(part), part);
  assert.doesNotMatch(text, /不可直接夹带原文|未选记录内容|note_secret/);
  assert.match(text, /此依据关联未选记录/);
});

test("C05 interleaved followups and reviews share one stable time axis", () => {
  const review = (id: string, created_at: string) =>
    ({ id, created_at }) as Review;
  const followup = (
    id: string,
    occurred_at: string | null,
    created_at: string,
  ) => ({ id, occurred_at, created_at }) as Note;
  const items = noteTimeline({
    reviews: [
      review("day3", "2026-01-03T00:00:00Z"),
      review("day1", "2026-01-01T00:00:00Z"),
    ],
    followups: [
      followup("day2", null, "2026-01-02T00:00:00Z"),
      followup("backdated", "2025-12-31T00:00:00Z", "2026-01-04T00:00:00Z"),
      followup("same_b", null, "2026-01-02T00:00:00Z"),
      followup("same_a", null, "2026-01-02T00:00:00Z"),
      followup("undated", null, ""),
    ],
  });
  assert.deepEqual(
    items.map((item) => item.id),
    ["backdated", "day1", "day2", "same_a", "same_b", "day3", "undated"],
  );
  assert.equal(items[0].time_source, "occurred_at");
  assert.equal(items[2].time_source, "created_at");
  assert.equal(items.at(-1)?.time_source, "missing");
});
