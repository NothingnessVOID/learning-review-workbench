import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Service } from "../src/domain/service.js";

async function fixture(run: (service: Service) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "learning-workbench-boundaries-"));
  const service = new Service(dir, process.cwd());
  try {
    await run(service);
  } finally {
    service.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
async function data(
  service: Service,
  tool: string,
  args: object,
  actor: "local_user" | "external_agent" = "local_user",
) {
  const result = await service.invoke(tool, args, actor);
  assert.equal(result.ok, true, `${tool}: ${JSON.stringify(result.error)}`);
  return result.data as any;
}
function permissions(
  service: Service,
  readLibrary: boolean,
  noteIds: string[],
) {
  service.store.setting("permissions", {
    read_library: readLibrary,
    append_notes: false,
    save_reviews: false,
    submit_courses: false,
    submit_knowledge: false,
    propose_relations: false,
    read_note_ids: noteIds,
  });
}

test("U06: an authorized note does not reveal revoked relation IDs or library relation details", async () => {
  await fixture(async (service) => {
    const s = service.store;
    s.put(
      "courses",
      {
        id: "course_private_demo",
        title: "DEMO 撤销资料",
        source_version_ids: [],
      },
      0,
    );
    s.put(
      "notes",
      {
        id: "note_allowed_demo",
        original_text: "DEMO 授权记录",
        type: "quick",
        relation_ids: ["course_private_demo", "note_hidden_demo"],
        parent_note_id: "note_hidden_demo",
      },
      0,
    );
    s.put(
      "notes",
      {
        id: "note_hidden_demo",
        original_text: "DEMO 未授权记录",
        type: "quick",
        relation_ids: [],
      },
      0,
    );
    s.put(
      "relations",
      {
        id: "rel_private_demo",
        from_id: "note_allowed_demo",
        to_id: "course_private_demo",
        kind: "related",
        reason: "DEMO 私有关系原因",
        status: "confirmed",
      },
      0,
    );
    permissions(service, false, ["note_allowed_demo"]);
    const note = await data(
      service,
      "get_note",
      { note_id: "note_allowed_demo" },
      "external_agent",
    );
    assert.deepEqual(note.resolved_relations, []);
    assert.equal(note.parent_note_id ?? null, null);
    const serialized = JSON.stringify(note);
    assert.equal(serialized.includes("course_private_demo"), false);
    assert.equal(serialized.includes("note_hidden_demo"), false);
    assert.equal(serialized.includes("DEMO 私有关系原因"), false);
  });
});

test("U06: a review is hidden unless every source note remains authorized", async () => {
  await fixture(async (service) => {
    const s = service.store;
    s.put(
      "notes",
      {
        id: "note_one_demo",
        original_text: "DEMO first",
        type: "quick",
        relation_ids: [],
      },
      0,
    );
    s.put(
      "notes",
      {
        id: "note_two_demo",
        original_text: "DEMO second",
        type: "quick",
        relation_ids: [],
      },
      0,
    );
    s.put(
      "reviews",
      {
        id: "review_both_demo",
        note_ids: ["note_one_demo", "note_two_demo"],
        body_md: "DEMO review both",
      },
      0,
    );
    permissions(service, true, ["note_one_demo"]);
    let note = await data(
      service,
      "get_note",
      { note_id: "note_one_demo" },
      "external_agent",
    );
    assert.equal(
      note.reviews.some((r: any) => r.id === "review_both_demo"),
      false,
    );
    let hits = await data(
      service,
      "search_library",
      { query: "DEMO review both", types: ["review"] },
      "external_agent",
    );
    assert.equal(hits.items.length, 0);
    permissions(service, true, ["note_one_demo", "note_two_demo"]);
    note = await data(
      service,
      "get_note",
      { note_id: "note_one_demo" },
      "external_agent",
    );
    assert.equal(
      note.reviews.some((r: any) => r.id === "review_both_demo"),
      true,
    );
    permissions(service, true, ["note_one_demo"]);
    note = await data(
      service,
      "get_note",
      { note_id: "note_one_demo" },
      "external_agent",
    );
    assert.equal(
      note.reviews.some((r: any) => r.id === "review_both_demo"),
      false,
    );
  });
});

test("U06/M01: note authorization is applied before cursor pagination", async () => {
  await fixture(async (service) => {
    const s = service.store;
    s.put(
      "notes",
      {
        id: "note_hidden_newer",
        original_text: "DEMO hidden",
        type: "quick",
        relation_ids: [],
        occurred_at: "2026-09-24T12:00:00+08:00",
      },
      0,
    );
    s.put(
      "notes",
      {
        id: "note_allowed_older",
        original_text: "DEMO allowed",
        type: "quick",
        relation_ids: [],
        occurred_at: "2026-09-23T12:00:00+08:00",
      },
      0,
    );
    permissions(service, false, ["note_allowed_older"]);
    const page = await data(
      service,
      "list_notes",
      { limit: 1 },
      "external_agent",
    );
    assert.equal(page.total, 1);
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0].id, "note_allowed_older");
    assert.equal(page.next_cursor, null);
  });
});

test("M01: draft and relation lists honor limit and cursor", async () => {
  await fixture(async (service) => {
    const s = service.store;
    for (let n = 1; n <= 2; n++) {
      s.put(
        "drafts",
        {
          id: `draft_demo_${n}`,
          entity_type: "course",
          entity_id: `course_demo_${n}`,
          status: "draft",
          payload: { title: `DEMO ${n}` },
        },
        0,
      );
      s.put(
        "relations",
        {
          id: `relation_demo_${n}`,
          from_id: `draft_demo_${n}`,
          to_id: `draft_demo_${n}`,
          kind: "related",
          reason: `DEMO 审核理由 ${n}`,
          status: "pending",
        },
        0,
      );
    }
    const drafts = await data(service, "list_drafts", { limit: 1 });
    assert.equal(drafts.items.length, 1);
    assert.ok(drafts.next_cursor);
    const nextDrafts = await data(service, "list_drafts", {
      limit: 1,
      cursor: drafts.next_cursor,
    });
    assert.equal(nextDrafts.items.length, 1);
    assert.notEqual(nextDrafts.items[0].id, drafts.items[0].id);
    const relations = await data(service, "list_relations", { limit: 1 });
    assert.equal(relations.items.length, 1);
    assert.ok(relations.next_cursor);
    assert.match(relations.items[0].reason, /^DEMO 审核理由/);
  });
});

test("M01: detail retrieval returns complete long body without silent truncation", async () => {
  await fixture(async (service) => {
    const body = "DEMO 完整正文。".repeat(20000);
    service.store.put(
      "cards",
      {
        id: "card_long_demo",
        title: "DEMO long",
        body_md: body,
        type: "concept",
        aliases: [],
        topic_ids: [],
        source_refs: [],
      },
      0,
    );
    const card = await data(service, "get_knowledge_card", {
      card_id: "card_long_demo",
    });
    assert.equal(card.body_md, body);
  });
});

test("M01: long list items are summaries while single-record detail preserves complete text", async () => {
  await fixture(async (service) => {
    const body = "DEMO 大型知识正文。".repeat(25000);
    for (let i = 0; i < 12; i++)
      service.store.put(
        "cards",
        {
          id: `card_large_${i}`,
          title: `DEMO card ${i}`,
          body_md: body,
          type: "concept",
          aliases: [],
          topic_ids: [],
          source_refs: [],
        },
        0,
      );
    const listed = await data(service, "list_knowledge", { limit: 100 });
    assert.equal(listed.items.length, 12);
    assert.equal(
      listed.items.every(
        (card: any) => card.summary_only && card.content_truncated,
      ),
      true,
    );
    assert.equal(
      listed.items.every((card: any) => card.body_md.length <= 360),
      true,
    );
    assert(Buffer.byteLength(JSON.stringify(listed)) < 2 * 1024 * 1024);
    const detail = await data(service, "get_knowledge_card", {
      card_id: "card_large_0",
    });
    assert.equal(detail.body_md, body);
  });
});

test("M01: oversized read returns explicit error and never a silent partial body", async () => {
  await fixture(async (service) => {
    const note = service.store.put(
      "notes",
      {
        id: "note_large_review",
        original_text: "DEMO 原始记录",
        type: "quick",
        relation_ids: [],
      },
      0,
    );
    const body = "大".repeat(280000);
    for (let i = 0; i < 3; i++)
      service.store.put(
        "reviews",
        { id: `review_large_${i}`, note_ids: [note.id], body_md: body },
        0,
      );
    const response = await service.invoke("get_note", { note_id: note.id });
    assert.equal(response.ok, false);
    assert.equal(response.error?.code, "PAYLOAD_TOO_LARGE");
    const one = await data(service, "get_review_result", {
      review_id: "review_large_0",
    });
    assert.equal(one.body_md, body);
  });
});
