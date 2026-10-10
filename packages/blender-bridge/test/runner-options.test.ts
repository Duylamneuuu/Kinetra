import assert from "node:assert/strict";
import test from "node:test";
import { BlenderBridgeError, NodeProcessRunner } from "../src/index.js";

test("NodeProcessRunner rejects a maxOutputChars that is not a positive integer", () => {
  for (const maxOutputChars of [Number.NaN, 0, -1, 1.5, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => new NodeProcessRunner({ maxOutputChars }),
      (err: unknown) =>
        err instanceof BlenderBridgeError &&
        err.code === "blender.invalidOption" &&
        err.details.option === "maxOutputChars",
      `maxOutputChars ${maxOutputChars}`,
    );
  }
});

test("NodeProcessRunner keeps only the tail of output beyond maxOutputChars", async () => {
  const runner = new NodeProcessRunner({ maxOutputChars: 16, timeoutMs: 30_000 });
  const result = await runner.run(process.execPath, [
    "-e",
    "process.stdout.write('a'.repeat(5000) + 'TAIL-STDOUT'); process.stderr.write('b'.repeat(5000) + 'TAIL-ERR');",
  ]);
  assert.equal(result.code, 0);
  assert.equal(result.stdout.length, 16);
  assert.ok(result.stdout.endsWith("TAIL-STDOUT"));
  assert.equal(result.stderr.length, 16);
  assert.ok(result.stderr.endsWith("TAIL-ERR"));
});
