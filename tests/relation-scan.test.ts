import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Service } from "../src/domain/service.js";

test("topic and card relation reads preserve direction, status, permissions and archives", async () => {
  const dir = mkdtempSync(join(tmpdir(), "workbench-relations-"));
  const service = new Service(dir, process.cwd());
  const put = (table: "notes" | "relations", id: string, value: object) =>
    service.store.put(table, { id, ...value }, 0);
  const read = async (
    tool: string,
    args: object,
    actor: "local_user" | "external_agent" = "local_user",
  ) => {
    const result = await service.invoke(tool, args, actor);
    assert.equal(result.ok, true, JSON.stringify(result.error));
    return result.data as any;
  };
  try {
    service.store.put("courses", { id: "course_relation_demo", title: "DEMO course" }, 0);
    service.store.put("topics", { id: "topic_relation_demo", course_id: "course_relation_demo", title: "DEMO topic", blocks: [] }, 0);
    service.store.put("cards", { id: "card_relation_demo", title: "DEMO card", topic_ids: [], body_md: "DEMO" }, 0);
    put("notes", "note_direct_demo", { original_text: "DEMO direct", relation_ids: ["topic_relation_demo", "card_relation_demo"] });
    put("notes", "note_confirmed_demo", { original_text: "DEMO confirmed", relation_ids: [] });
    put("notes", "note_pending_demo", { original_text: "DEMO pending", relation_ids: [] });
    put("notes", "note_rejected_demo", { original_text: "DEMO rejected", relation_ids: [] });
    put("notes", "note_private_demo", { original_text: "DEMO private", relation_ids: ["topic_relation_demo"] });
    put("notes", "note_archived_demo", { original_text: "DEMO archived", relation_ids: ["topic_relation_demo"], archived: true });
    put("notes", "note_reverse_demo", { original_text: "DEMO reverse", relation_ids: ["note_direct_demo"] });
    put("relations", "relation_confirmed_demo", { from_id: "topic_relation_demo", to_id: "note_confirmed_demo", status: "confirmed" });
    put("relations", "relation_pending_demo", { from_id: "note_pending_demo", to_id: "topic_relation_demo", status: "pending" });
    put("relations", "relation_rejected_demo", { from_id: "note_rejected_demo", to_id: "topic_relation_demo", status: "rejected" });
    const topicNotes = (await read("get_topic", { topic_id: "topic_relation_demo" })).notes;
    assert.deepEqual(new Set(topicNotes.map((note: any) => note.id)), new Set(["note_direct_demo", "note_confirmed_demo", "note_private_demo"]));
    assert.deepEqual((await read("get_knowledge_card", { card_id: "card_relation_demo" })).notes.map((note: any) => note.id), ["note_direct_demo"]);
    assert((await read("get_note", { note_id: "note_direct_demo" })).relation_ids.includes("note_reverse_demo"));
    service.store.setting("permissions", { ...service.permissions, read_note_ids: ["note_direct_demo", "note_confirmed_demo", "note_pending_demo", "note_rejected_demo"], read_library: true });
    assert.deepEqual(new Set((await read("get_topic", { topic_id: "topic_relation_demo" }, "external_agent")).notes.map((note: any) => note.id)), new Set(["note_direct_demo", "note_confirmed_demo"]));
    assert(!(await read("get_note", { note_id: "note_direct_demo" }, "external_agent")).relation_ids.includes("note_reverse_demo"));
    const confirmed = service.store.get("relations", "relation_confirmed_demo")!;
    service.store.put("relations", { ...confirmed, status: "rejected" }, confirmed.revision);
    assert.deepEqual((await read("get_topic", { topic_id: "topic_relation_demo" }, "external_agent")).notes.map((note: any) => note.id), ["note_direct_demo"]);
    const direct = service.store.get("notes", "note_direct_demo")!;
    service.store.put("notes", { ...direct, archived: true }, direct.revision);
    assert.equal((await read("get_topic", { topic_id: "topic_relation_demo" }, "external_agent")).notes.length, 0);
    const archived = await read("list_notes", { include_archived: true, relation_id: "topic_relation_demo" });
    assert(archived.items.some((note: any) => note.id === "note_direct_demo" && note.archived));
  } finally {
    service.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
