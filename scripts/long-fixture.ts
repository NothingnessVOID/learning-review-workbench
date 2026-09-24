// Synthetic shape benchmark only; never use the private data directory.
import { Service } from "../src/domain/service.js";
import { uid } from "../src/domain/store.js";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
const dir = resolve(process.argv[2] ?? "");
if (!dir.startsWith(resolve(tmpdir()) + "/workbench-e2e-"))
  throw Error("Fixture requires isolated test directory");
const service = new Service(dir, process.cwd());
async function call(tool: string, args: any = {}) {
  const r = await service.invoke(tool, args);
  if (!r.ok) throw Error(JSON.stringify(r.error));
  return r.data as any;
}
try {
  const sourceText = Array.from(
    { length: 20 },
    (_, i) =>
      `## Synthetic long topic ${i}\n\n${"工程合成长文本，保留条件、说明与上下文；不来自用户课程。\n\n".repeat(120)}`,
  ).join("\n");
  for (let version = 0; version < 3; version++) {
    const p = await call("preview_import", {
      files: [
        {
          name: "DEMO-long-course.md",
          content_base64: Buffer.from(
            `# DEMO long course\nVersion ${version}\n${sourceText}`,
          ).toString("base64"),
        },
      ],
      source_kind: "other",
    });
    await call("commit_import", { preview_id: p.id });
  }
  const topics = service.store.all("topics"),
    blocks = service.store.all("blocks");
  for (let i = 0; i < 300; i++) {
    const block = blocks[i % blocks.length];
    service.store.put(
      "cards",
      {
        id: uid("card"),
        title: `DEMO long card ${i}`,
        original_name: `合成条目${i}`,
        type: "concept",
        original_type: "synthetic",
        aliases: [],
        body_md: "工程合成知识正文。".repeat(800),
        topic_ids: [topics[i % topics.length].id],
        source_refs: [
          {
            source_document_id: block.source_document_id,
            source_version_id: block.source_version_id,
            source_block_id: block.id,
          },
        ],
        verification_status: "needs_review",
        author_type: "demo_fixture",
      },
      0,
    );
  }
  const ids = [];
  for (let i = 0; i < 160; i++) {
    const note = await call("create_note", {
      original_text: `DEMO shape note ${i}，工程合成事件与条件。`,
      client_request_id: uid("req"),
    });
    ids.push(note.id);
    if (i < 40)
      await call("save_review_result", {
        note_ids: [note.id],
        body_md:
          `DEMO long review ${i}\n` +
          "工程合成复盘，条件和后续记录。".repeat(2500),
        gaps: ["Synthetic benchmark only"],
        client_request_id: uid("req"),
      });
  }
  await call("set_permissions", {
    permissions: { ...service.permissions, read_note_ids: ids },
  });
  console.log(
    "Synthetic fixture: 3 source versions, 300 long cards, 160 notes, 40 long reviews.",
  );
} finally {
  service.store.close();
}
