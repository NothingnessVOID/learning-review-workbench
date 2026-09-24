import assert from "node:assert/strict";
import { resolve, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = resolve(import.meta.dirname, "..");
const client = new Client({
  name: "learning-workbench-live-check",
  version: "1.0.0",
});
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(root, "dist/stdio.js")],
  cwd: root,
  env: { ...process.env },
  stderr: "pipe",
});
try {
  await client.connect(transport);
  const listed = await client.listTools();
  assert.equal(listed.tools.length, 21);
  for (const [name, args] of [
    ["get_status", {}],
    ["get_schema", { entity_type: "note" }],
    ["get_agent_context", { sections: ["user"] }],
  ]) {
    const response = await client.callTool({ name, arguments: args });
    assert.equal(response.isError, false, `${name} failed`);
    assert.equal(
      response.structuredContent?.ok,
      true,
      `${name} returned an error`,
    );
    assert(response.content.some((item) => item.type === "text"));
    process.stdout.write(`${name}: ok\n`);
  }
  const call = async (name, args) => {
    const response = await client.callTool({ name, arguments: args });
    assert.equal(
      response.structuredContent?.ok,
      true,
      `${name} returned an error`,
    );
    return response.structuredContent.data;
  };
  const courses = await call("list_courses", {});
  for (const course of courses.items)
    assert.equal(
      Object.hasOwn(course, "learning_state"),
      false,
      "MCP course list exposed personal learning state",
    );
  if (courses.items.length) {
    const course = await call("get_course", { course_id: courses.items[0].id });
    assert.equal(
      Object.hasOwn(course, "learning_state"),
      false,
      "MCP course exposed personal learning state",
    );
    if (course.topics.length) {
      const topic = await call("get_topic", { topic_id: course.topics[0].id });
      assert.equal(
        Object.hasOwn(topic, "learning_state"),
        false,
        "MCP topic exposed personal learning state",
      );
      assert.equal(
        Object.hasOwn(topic.course, "learning_state"),
        false,
        "MCP nested course exposed personal learning state",
      );
    }
  }
  const knowledge = await call("list_knowledge", {});
  if (knowledge.items.length) {
    const card = await call("get_knowledge_card", {
      card_id: knowledge.items[0].id,
    });
    assert.equal(
      Object.hasOwn(card, "learning_state"),
      false,
      "MCP card exposed personal learning state",
    );
  }
  process.stdout.write("MCP personal learning state isolation: ok\n");
  process.stdout.write(`MCP tools/list: ${listed.tools.length} tools\n`);
} finally {
  await client.close();
}
