import assert from "node:assert/strict";
import test from "node:test";
import { BoundedLogBuffer } from "../src/log-buffer.js";

test("bounded log buffer drops oldest debug before info, warning, and error", () => {
  const buffer = new BoundedLogBuffer(2);
  buffer.append("debug", "debug-old");
  buffer.append("info", "runtime.started");
  buffer.append("error", "script.error");

  assert.equal(buffer.dropped, 1);
  assert.equal(buffer.retained, 2);
  assert.deepEqual(
    buffer.read().map((entry) => entry.message),
    ["runtime.started", "script.error"],
  );

  buffer.append("debug", "debug-new");
  assert.deepEqual(
    buffer.read().map((entry) => [entry.level, entry.message]),
    [
      ["info", "runtime.started"],
      ["error", "script.error"],
    ],
  );
  assert.equal(buffer.dropped, 2);

  buffer.append("warning", "nav.partial");
  assert.deepEqual(
    buffer.read().map((entry) => entry.message),
    ["script.error", "nav.partial"],
  );
});

test("bounded log buffer keeps sequence order and clones data", () => {
  const buffer = new BoundedLogBuffer(2);
  const data = { action: "player.jump" };
  const first = buffer.append("info", "runtime.input", data);
  data.action = "mutated";
  assert.equal(first.data?.action, "player.jump");

  buffer.append("info", "runtime.stopped");
  buffer.append("info", "later");
  const read = buffer.read(first.sequence);
  assert.deepEqual(
    read.map((entry) => entry.message),
    ["runtime.stopped", "later"],
  );
  const again = buffer.read(0);
  assert.equal(again[0]?.sequence, read[0]?.sequence);
  again[0]!.data = { action: "tamper" };
  assert.equal(buffer.read(0)[0]?.data, undefined);

  assert.throws(() => new BoundedLogBuffer(0), /capacity/);
  assert.throws(() => buffer.read(-1), /sinceSequence/);
});

test("bounded log buffer drops oldest errors only after higher priorities are gone", () => {
  const buffer = new BoundedLogBuffer(1);
  buffer.append("error", "first");
  buffer.append("error", "second");
  assert.equal(buffer.dropped, 1);
  assert.deepEqual(
    buffer.read().map((entry) => entry.message),
    ["second"],
  );
  assert.ok(buffer.read()[0]!.sequence > 1);
});
