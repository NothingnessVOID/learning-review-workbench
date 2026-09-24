import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Service } from "../src/domain/service.js";
import {
  listNotesSchema,
  searchLibrarySchema,
} from "../src/domain/contracts.js";

function rangeIn(timezone: string, day: string) {
  return JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `import { calendarDateRange } from './src/web/dates.ts'; console.log(JSON.stringify(calendarDateRange({from:${JSON.stringify(day)},to:${JSON.stringify(day)}})));`,
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, TZ: timezone },
        encoding: "utf8",
      },
    ),
  );
}

test("B02 browser-local calendar bounds cover Singapore and both DST day lengths", () => {
  assert.deepEqual(rangeIn("Asia/Singapore", "2026-09-24"), {
    from: "2026-09-23T16:00:00.000Z",
    to_exclusive: "2026-09-24T16:00:00.000Z",
  });
  const spring = rangeIn("America/New_York", "2026-03-08");
  assert.equal(spring.from, "2026-03-08T05:00:00.000Z");
  assert.equal(spring.to_exclusive, "2026-03-09T04:00:00.000Z");
  assert.equal(
    Date.parse(spring.to_exclusive) - Date.parse(spring.from),
    23 * 3600000,
  );
  const fall = rangeIn("America/New_York", "2026-11-01");
  assert.equal(fall.from, "2026-11-01T04:00:00.000Z");
  assert.equal(fall.to_exclusive, "2026-11-02T05:00:00.000Z");
  assert.equal(
    Date.parse(fall.to_exclusive) - Date.parse(fall.from),
    25 * 3600000,
  );
});

test("B02 local half-open bounds agree in note list/search and exclude the exact next midnight", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wb-date-"));
  const service = new Service(dir, process.cwd());
  const call = async (tool: string, args: any = {}) => {
    const r = await service.invoke(tool, args);
    assert.equal(r.ok, true, JSON.stringify(r.error));
    return r.data as any;
  };
  try {
    const range = rangeIn("Asia/Singapore", "2026-09-24");
    const stamps = [
      "2026-09-23T23:59:59+08:00",
      "2026-09-24T00:00:00+08:00",
      "2026-09-24T00:10:00+08:00",
      "2026-09-24T23:59:59.999+08:00",
      "2026-09-25T00:00:00+08:00",
      "2026-09-25T00:10:00+08:00",
    ];
    const notes = [];
    for (const [i, occurred_at] of stamps.entries())
      notes.push(
        await call("create_note", {
          original_text: `合成日期边界 ${i}`,
          occurred_at,
          client_request_id: `date_test_${i}`,
        }),
      );
    const expected = [notes[3].id, notes[2].id, notes[1].id];
    const list = await call("list_notes", range);
    assert.deepEqual(
      list.items.map((x: any) => x.id),
      expected,
    );
    const search = await call("search_library", {
      query: "合成日期边界",
      types: ["note"],
      ...range,
    });
    assert.deepEqual(
      new Set(search.items.map((x: any) => x.id)),
      new Set(expected),
    );
    for (const item of search.items) {
      assert.equal(item.date_basis, "occurred_at");
      assert.ok(item.occurred_at);
      assert.ok(item.created_at);
    }
    assert.equal(
      (await service.invoke("list_notes", { ...range, to: "2026-09-24" })).error
        ?.code,
      "VALIDATION_ERROR",
    );
    assert.equal(
      (
        await service.invoke("search_library", {
          query: "合成",
          from: range.to_exclusive,
          to_exclusive: range.from,
        })
      ).error?.code,
      "VALIDATION_ERROR",
    );
    for (const schema of [listNotesSchema, searchLibrarySchema])
      assert.equal(
        schema.safeParse({ query: "合成", to_exclusive: "2026-09-24" }).success,
        false,
      );
  } finally {
    service.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
