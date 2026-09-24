import assert from "node:assert/strict";
import { request } from "node:http";
import { startTestServer, session } from "./test-server.mjs";
const first = await startTestServer(),
  second = await startTestServer();
try {
  const a = await session(first.base),
    b = await session(second.base);
  assert.notEqual(
    a.cookie.split("=")[0],
    b.cookie.split("=")[0],
    "R08 cookie namespaces must differ by instance",
  );
  const jar = [a.cookie, b.cookie].join("; ");
  for (const [server, s] of [
    [first, a],
    [second, b],
  ]) {
    const rpc = async (tool, args = {}, extra = {}) =>
      (
        await fetch(server.base + "/api/rpc", {
          method: "POST",
          headers: {
            cookie: jar,
            "x-csrf-token": s.csrf,
            "content-type": "application/json",
            ...extra,
          },
          body: JSON.stringify({ tool, args }),
        })
      ).json();
    const status = await rpc("get_status");
    assert.equal(status.ok, true);
    assert.equal(status.data.mode, "demo");
    assert.equal(
      (await rpc("get_status", { unexpected: true })).error?.code,
      "VALIDATION_ERROR",
    );
    assert.equal(
      (await rpc("list_notes", { from: "2026-02-30" })).error?.code,
      "VALIDATION_ERROR",
    );
    const h = await (await fetch(server.base + "/health")).json();
    assert.match(h.build.fingerprint, /^[a-f0-9]{64}$/);
    const again = await fetch(server.base + "/api/session", {
      headers: { cookie: jar },
    });
    assert.equal(
      (await again.json()).csrf,
      s.csrf,
      "same-instance tabs should reuse session",
    );
    assert.equal(
      (await rpc("get_status", {}, { "x-csrf-token": "wrong" })).ok,
      false,
    );
    assert.equal(
      (
        await fetch(server.base + "/health", {
          headers: { origin: "https://attacker.example" },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(server.base + "/api/rpc", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: '{"tool":"get_status"}',
        })
      ).status,
      403,
    );
    const wrong = await new Promise((resolve, reject) => {
      const r = request(
        {
          hostname: "127.0.0.1",
          port: server.port,
          path: "/health",
          headers: { Host: "attacker.example" },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode));
        },
      );
      r.on("error", reject);
      r.end();
    });
    assert.equal(wrong, 403);
    for (const tool of [
      "commit_restore",
      "set_permissions",
      "review_draft",
      "preview_import",
      "get_review_handoff",
    ]) {
      const r = await (
        await fetch(server.base + "/api/mcp", {
          method: "POST",
          headers: {
            authorization: `Bearer ${server.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ tool, args: {} }),
        })
      ).json();
      assert.equal(r.error?.code, "PERMISSION_DENIED", tool);
    }
    const ex = await rpc("export_data", { scope: "all" });
    assert.equal(ex.ok, true, JSON.stringify(ex.error));
    const download = await fetch(server.base + ex.data.download_url, {
      headers: { cookie: jar },
    });
    assert.equal(download.status, 200);
    assert.equal(
      Buffer.from(await download.arrayBuffer())
        .subarray(0, 2)
        .toString(),
      "PK",
    );
  }
  console.log(
    "HTTP regression passed: independent cookie jars, reused tab session, downloads across two ports, Host/Origin/CSRF, UI-only tools, running build.",
  );
} finally {
  await first.stop();
  await second.stop();
}
