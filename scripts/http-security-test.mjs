import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { resolve, join } from "node:path";

const root = resolve(import.meta.dirname, "..");
const demoDir = join(root, ".data/demo");
assert.equal(
  process.env.LEARNING_WORKBENCH_URL,
  "http://127.0.0.1:47832",
  "此脚本仅允许 47832 演示服务",
);
assert.equal(
  resolve(process.env.LEARNING_WORKBENCH_DATA_DIR ?? ""),
  demoDir,
  "此脚本仅允许项目 .data/demo 数据目录",
);
const base = process.env.LEARNING_WORKBENCH_URL;
let cookie;
let csrf;
let originalPermissions;
let changed = false;

async function request(path, { headers = {}, body, method = "POST" } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json() };
}
async function wrongHostRequest() {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: "127.0.0.1",
        port: 47832,
        path: "/health",
        method: "GET",
        headers: { Host: "attacker.example" },
      },
      (response) => {
        let body = "";
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          try {
            resolve({ status: response.statusCode, body: JSON.parse(body) });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}
async function ui(tool, args, extraHeaders = {}) {
  return request("/api/rpc", {
    headers: { cookie, "x-csrf-token": csrf, ...extraHeaders },
    body: { tool, args },
  });
}
async function mcp(tool, args, bearer) {
  return request("/api/mcp", {
    headers: { authorization: `Bearer ${bearer}` },
    body: { tool, args },
  });
}
function denied(response, code = "PERMISSION_DENIED") {
  assert.equal(response.body.ok, false);
  assert.equal(response.body.error?.code, code);
}
const token = JSON.parse(
  await readFile(join(demoDir, "credentials.json"), "utf8"),
).token;
try {
  denied(await wrongHostRequest());
  denied(
    await request("/health", {
      method: "GET",
      headers: { origin: "https://attacker.example" },
    }),
  );
  denied(await request("/api/rpc", { body: { tool: "get_status", args: {} } }));
  const session = await fetch(`${base}/api/session`);
  assert.equal(session.status, 200);
  cookie = session.headers.get("set-cookie")?.split(";", 1)[0];
  assert(cookie);
  csrf = (await session.json()).csrf;
  denied(
    await request("/api/rpc", {
      headers: { cookie },
      body: { tool: "get_status", args: {} },
    }),
  );
  denied(await mcp("get_status", {}, "invalid-demo-token"));
  for (const tool of [
    "review_draft",
    "set_permissions",
    "commit_restore",
    "rotate_mcp_token",
  ]) {
    denied(await mcp(tool, {}, token));
  }

  const status = await ui("get_status", {});
  assert.equal(status.body.ok, true);
  originalPermissions = status.body.data.permissions;
  const permissionFlags = Object.fromEntries(
    [
      "read_library",
      "append_notes",
      "save_reviews",
      "submit_courses",
      "submit_knowledge",
      "propose_relations",
    ].map((key) => [key, originalPermissions[key]]),
  );
  process.stdout.write(
    `Demo baseline permissions: ${JSON.stringify(permissionFlags)}, read_note_ids_count=${originalPermissions.read_note_ids.length}\n`,
  );
  await ui("set_permissions", {
    permissions: { ...originalPermissions, read_library: true },
  });
  changed = true;
  const courses = await mcp("list_courses", {}, token);
  assert.equal(courses.body.ok, true);
  assert(courses.body.data.items.length > 0, "演示库需要至少一门课程");
  for (const course of courses.body.data.items)
    assert.equal(
      Object.hasOwn(course, "learning_state"),
      false,
      "课程列表泄露个人学习状态",
    );
  const course = await mcp(
    "get_course",
    { course_id: courses.body.data.items[0].id },
    token,
  );
  assert.equal(course.body.ok, true);
  assert.equal(
    Object.hasOwn(course.body.data, "learning_state"),
    false,
    "课程详情泄露个人学习状态",
  );
  if (course.body.data.topics.length) {
    const topic = await mcp(
      "get_topic",
      { topic_id: course.body.data.topics[0].id },
      token,
    );
    assert.equal(topic.body.ok, true);
    assert.equal(
      Object.hasOwn(topic.body.data, "learning_state"),
      false,
      "主题详情泄露个人学习状态",
    );
    assert.equal(
      Object.hasOwn(topic.body.data.course, "learning_state"),
      false,
      "主题嵌套课程泄露个人学习状态",
    );
  }
  const cards = await mcp("list_knowledge", {}, token);
  assert.equal(cards.body.ok, true);
  if (cards.body.data.items.length) {
    const card = await mcp(
      "get_knowledge_card",
      { card_id: cards.body.data.items[0].id },
      token,
    );
    assert.equal(card.body.ok, true);
    assert.equal(
      Object.hasOwn(card.body.data, "learning_state"),
      false,
      "知识卡泄露个人学习状态",
    );
  }

  const revoked = await ui("set_permissions", {
    permissions: { ...originalPermissions, read_library: false },
  });
  assert.equal(revoked.body.ok, true);
  const context = await mcp("get_agent_context", { sections: ["user"] }, token);
  assert.equal(context.body.ok, true);
  assert.deepEqual(
    context.body.data.available_materials,
    [],
    "撤销资料读取权限后仍返回来源文件名",
  );
  denied(await mcp("list_courses", {}, token));
  process.stdout.write(
    "HTTP demo security: Host, Origin, session, CSRF, token, UI-only denial, personal layer and source scope: passed\n",
  );
  process.stdout.write(
    "MCP calls checked: get_status, review_draft, set_permissions, commit_restore, rotate_mcp_token, list_courses, get_course, get_topic, list_knowledge, get_knowledge_card, get_agent_context\n",
  );
} finally {
  if (changed) {
    try {
      const restored = await ui("set_permissions", {
        permissions: originalPermissions,
      });
      assert.equal(restored.body.ok, true);
      const confirmed = await ui("get_status", {});
      assert.deepEqual(confirmed.body.data.permissions, originalPermissions);
      process.stdout.write("Demo permissions restored\n");
    } catch (error) {
      process.stderr.write(
        `DEMO PERMISSIONS RESTORE FAILED: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    }
  }
}
