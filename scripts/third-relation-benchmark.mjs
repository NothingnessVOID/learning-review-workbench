// Synthetic, isolated SQLite benchmark of the real topic and card read APIs.
// Run: node --import tsx scripts/third-relation-benchmark.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Service } from "../src/domain/service.ts";

const output = "artifacts/test-results/third-relation-benchmark.json";
const counts = [100, 1000, 10000];
const rows = [];

for (const count of counts) {
  const dir = mkdtempSync(join(tmpdir(), "workbench-relation-benchmark-"));
  const service = new Service(dir, process.cwd());
  try {
    service.store.put("courses", { id: "course_benchmark_demo", title: "DEMO" }, 0);
    service.store.put("topics", { id: "topic_benchmark_demo", course_id: "course_benchmark_demo", title: "DEMO", blocks: [] }, 0);
    service.store.put("cards", { id: "card_benchmark_demo", title: "DEMO", topic_ids: [], body_md: "DEMO" }, 0);
    const insert = service.store.db.prepare("INSERT INTO notes(id,revision,created_at,updated_at,archived,parent_id,title,search_text,data) VALUES(?,?,?,?,?,?,?,?,?)");
    service.store.db.exec("BEGIN");
    try {
      for (let i = 0; i < count; i++) {
        const id = `note_benchmark_${String(i).padStart(5, "0")}`;
        const date = "2026-01-01T00:00:00.000Z";
        const relation_ids = i === 0 ? ["topic_benchmark_demo"] : [];
        const note = { id, revision: 1, created_at: date, updated_at: date, archived: false, original_text: "DEMO", relation_ids };
        insert.run(id, 1, date, date, 0, null, "DEMO", "demo", JSON.stringify(note));
      }
      service.store.db.exec("COMMIT");
    } catch (error) {
      service.store.db.exec("ROLLBACK");
      throw error;
    }
    service.store.put("relations", { id: "relation_card_benchmark_demo", from_id: "card_benchmark_demo", to_id: "note_benchmark_00001", status: "confirmed" }, 0);
    const originalAll = service.store.all.bind(service.store);
    const metrics = { notes_reads: 0, notes_decoded: 0, relations_reads: 0 };
    service.store.all = (table, includeArchived) => {
      const values = originalAll(table, includeArchived);
      if (table === "notes") {
        metrics.notes_reads++;
        metrics.notes_decoded += values.length;
      }
      if (table === "relations") metrics.relations_reads++;
      return values;
    };
    for (const [tool, args, expected] of [
      ["get_topic", { topic_id: "topic_benchmark_demo" }, "note_benchmark_00000"],
      ["get_knowledge_card", { card_id: "card_benchmark_demo" }, "note_benchmark_00001"],
    ]) {
      const before = { ...metrics };
      const start = performance.now();
      const response = await service.invoke(tool, args);
      const elapsed_ms = performance.now() - start;
      assert.equal(response.ok, true, `${tool}: ${JSON.stringify(response.error)}`);
      assert.deepEqual(response.data.notes.map((note) => note.id), [expected]);
      const notes_reads = metrics.notes_reads - before.notes_reads;
      const notes_decoded = metrics.notes_decoded - before.notes_decoded;
      const relations_reads = metrics.relations_reads - before.relations_reads;
      assert.equal(notes_reads, 1);
      assert.equal(notes_decoded, count);
      assert.equal(relations_reads, 1);
      rows.push({ note_count: count, tool, notes_reads, notes_decoded, relations_reads, elapsed_ms: Number(elapsed_ms.toFixed(2)) });
    }
  } finally {
    service.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
mkdirSync("artifacts/test-results", { recursive: true });
writeFileSync(output, JSON.stringify({ synthetic: true, platform: process.platform, node: process.version, rows }, null, 2) + "\n");
for (const row of rows) console.log(`${row.note_count} ${row.tool}: ${row.notes_reads} notes read, ${row.notes_decoded} decoded, ${row.elapsed_ms} ms`);
console.log(output);
