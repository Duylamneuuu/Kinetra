import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_MAX_LOG_ENTRIES, RuntimeLogBuffer, cloneLogData } from "../src/log-buffer.js";

test("the buffer is bounded: the oldest entries are evicted and sequence numbers keep rising", () => {
  const buffer = new RuntimeLogBuffer(3);
  for (let i = 1; i <= 7; i++) {
    buffer.push("debug", `m${i}`);
  }
  assert.equal(buffer.size, 3);
  assert.equal(buffer.droppedCount, 4);
  assert.deepEqual(
    buffer.read().map((entry) => [entry.sequence, entry.message]),
    [
      [5, "m5"],
      [6, "m6"],
      [7, "m7"],
    ],
  );
});

test("a cursor taken before an eviction still returns only newer entries", () => {
  const buffer = new RuntimeLogBuffer(2);
  buffer.push("info", "a");
  const cursor = buffer.push("info", "b").sequence;
  buffer.push("info", "c");
  buffer.push("info", "d");
  assert.deepEqual(
    buffer.read(cursor).map((entry) => entry.message),
    ["c", "d"],
  );
  assert.deepEqual(buffer.read(1_000), []);
});

test("the default capacity is large but finite", () => {
  const buffer = new RuntimeLogBuffer();
  for (let i = 0; i < DEFAULT_MAX_LOG_ENTRIES + 25; i++) {
    buffer.push("debug", "tick");
  }
  assert.equal(buffer.size, DEFAULT_MAX_LOG_ENTRIES);
  assert.equal(buffer.droppedCount, 25);
  assert.equal(buffer.read()[0]?.sequence, 26);
});

test("a non-positive or fractional capacity is rejected", () => {
  assert.throws(() => new RuntimeLogBuffer(0), RangeError);
  assert.throws(() => new RuntimeLogBuffer(-1), RangeError);
  assert.throws(() => new RuntimeLogBuffer(1.5), RangeError);
  assert.throws(() => new RuntimeLogBuffer(Number.NaN), RangeError);
});

test("logging data that structuredClone refuses does not throw and keeps the clonable parts", () => {
  const buffer = new RuntimeLogBuffer();
  const entry = buffer.push("warning", "script.log", {
    entityId: "e1",
    callback: function onHit() {
      return 1;
    },
    nested: { ok: 1, big: 10n },
  });
  assert.equal(entry.message, "script.log");
  assert.ok(entry.data);
  assert.equal(entry.data.entityId, "e1");
  assert.equal(entry.data.callback, "[function onHit]");
  assert.deepEqual(entry.data.nested, { ok: 1, big: "10n" });
  assert.equal(entry.data.logDataSanitized, true);
  assert.equal(buffer.read().length, 1);
});

test("data holding a cycle plus a function is sanitised instead of throwing", () => {
  const data: Record<string, unknown> = { fn: () => 0 };
  data.self = data;
  const copy = cloneLogData(data);
  assert.equal(copy.logDataSanitized, true);
  assert.equal(copy.self, "[circular]");
});

test("data that cannot be serialised at all is reported by a marker", () => {
  const data = {
    fn: () => 0,
    toJSON() {
      throw new Error("no json for you");
    },
  };
  assert.deepEqual(cloneLogData(data), { logDataUnserializable: true });
});

test("clonable data is stored as an independent copy, on write and on read", () => {
  const buffer = new RuntimeLogBuffer();
  const data = { list: [1, 2], at: { x: 1 } };
  buffer.push("info", "m", data);
  data.list.push(3);
  data.at.x = 99;

  const first = buffer.read();
  const firstData = first[0]?.data;
  assert.ok(firstData);
  assert.deepEqual(firstData, { list: [1, 2], at: { x: 1 } });
  (firstData.list as number[]).push(42);
  assert.deepEqual(buffer.read()[0]?.data, { list: [1, 2], at: { x: 1 } });
  assert.equal("logDataSanitized" in firstData, false);
});
