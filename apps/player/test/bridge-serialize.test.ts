import assert from "node:assert/strict";
import test from "node:test";

import {
  BRIDGE_MALFORMED_RENDERER_RESPONSE,
  createCircularHarnessResult,
  normalizeRendererResponse,
  recoverRendererResponseId,
  serializeBridgeMessage,
} from "../electron/bridge-protocol.js";

// Luồng C: a bridge response whose `result` cannot be JSON-serialised (circular reference, BigInt)
// used to make `bridgeWrite` throw inside an un-awaited async handler. No reply was ever written,
// so the client (probe / MCP) hung until its own timeout. The serialiser must always produce
// exactly one parseable line, falling back to a structured failure that keeps the request id.

function parseLine(line: string): Record<string, unknown> {
  assert.ok(line.endsWith("\n"), "a bridge message is newline-terminated");
  assert.equal(line.slice(0, -1).includes("\n"), false, "and is exactly one line");
  return JSON.parse(line) as Record<string, unknown>;
}

test("a normal response serialises to one JSON line unchanged", () => {
  const message = { type: "response", id: "1", ok: true, result: { a: [1, 2, { b: "x\ny" }] } };
  assert.deepEqual(parseLine(serializeBridgeMessage(message)), message);
});

test("an event serialises to one JSON line", () => {
  assert.deepEqual(parseLine(serializeBridgeMessage({ type: "event", event: "ready" })), {
    type: "event",
    event: "ready",
  });
});

test("the circular harness is unsupported unless test hooks are on, and its result fails serialization", () => {
  assert.throws(
    () => createCircularHarnessResult(false),
    /Unsupported runtime bridge method "testHarness.circularResult"/,
  );
  const result = createCircularHarnessResult(true);
  assert.equal(result.kind, "circular");
  assert.equal(result.self, result);
  const parsed = parseLine(
    serializeBridgeMessage({ type: "response", id: "hook-1", ok: true, result }),
  );
  assert.equal(parsed.id, "hook-1");
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, "BRIDGE_UNSERIALIZABLE_RESPONSE");
  assert.match(String(parsed.error), /^BRIDGE_UNSERIALIZABLE_RESPONSE: /);
});

test("a circular result becomes a structured failure that keeps the request id", () => {
  const result: Record<string, unknown> = { name: "loop" };
  result.self = result;
  const parsed = parseLine(serializeBridgeMessage({ type: "response", id: "req-7", ok: true, result }));
  assert.equal(parsed.type, "response");
  assert.equal(parsed.id, "req-7");
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, "BRIDGE_UNSERIALIZABLE_RESPONSE");
  assert.match(String(parsed.error), /^BRIDGE_UNSERIALIZABLE_RESPONSE: /);
});

test("a BigInt result becomes a structured failure instead of throwing", () => {
  const parsed = parseLine(
    serializeBridgeMessage({ type: "response", id: "big", ok: true, result: { n: 10n } }),
  );
  assert.equal(parsed.id, "big");
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, "BRIDGE_UNSERIALIZABLE_RESPONSE");
});

test("a message JSON.stringify turns into undefined still yields a line", () => {
  const parsed = parseLine(serializeBridgeMessage(undefined));
  assert.equal(parsed.type, "response");
  assert.equal(parsed.id, null);
  assert.equal(parsed.ok, false);
});

test("an unserialisable value without a string id falls back to a null id", () => {
  const value: Record<string, unknown> = {};
  value.self = value;
  const parsed = parseLine(serializeBridgeMessage(value));
  assert.equal(parsed.id, null);
  assert.equal(parsed.ok, false);
});

test("a throwing toJSON never escapes the serialiser", () => {
  const evil = {
    type: "response",
    id: "toJSON",
    ok: true,
    result: {
      toJSON() {
        throw new Error("boom");
      },
    },
  };
  const parsed = parseLine(serializeBridgeMessage(evil));
  assert.equal(parsed.id, "toJSON");
  assert.equal(parsed.ok, false);
  assert.match(String(parsed.error), /boom/);
});

test("normalizeRendererResponse accepts well-formed renderer replies", () => {
  assert.deepEqual(normalizeRendererResponse({ id: "renderer_1", ok: true, result: { x: 1 } }), {
    id: "renderer_1",
    ok: true,
    result: { x: 1 },
  });
  assert.deepEqual(normalizeRendererResponse({ id: "renderer_2", ok: false, error: "nope" }), {
    id: "renderer_2",
    ok: false,
    error: "nope",
  });
});

test("normalizeRendererResponse rejects malformed renderer replies instead of throwing", () => {
  for (const raw of [undefined, null, 5, "x", [], {}, { id: 3, ok: true }, { id: "r", ok: "yes" }, { ok: true }]) {
    assert.equal(normalizeRendererResponse(raw), null, JSON.stringify(raw));
  }
});

test("normalizeRendererResponse ignores a non-string error field", () => {
  assert.deepEqual(normalizeRendererResponse({ id: "r", ok: false, error: { message: "x" } }), {
    id: "r",
    ok: false,
  });
});

test("recoverRendererResponseId returns the id of a malformed reply that still has a string id", () => {
  for (const raw of [
    { id: "renderer_3", ok: "yes" },
    { id: "renderer_4" },
    { id: "renderer_5", ok: 1, result: {} },
  ]) {
    assert.equal(normalizeRendererResponse(raw), null);
    assert.equal(recoverRendererResponseId(raw), raw.id, JSON.stringify(raw));
  }
});

test("recoverRendererResponseId returns null when no usable id exists", () => {
  for (const raw of [undefined, null, 5, "x", [], {}, { id: 3 }, { id: "" }, { id: null, ok: true }]) {
    assert.equal(recoverRendererResponseId(raw), null, JSON.stringify(raw));
  }
});

test("recoverRendererResponseId never throws on a hostile payload", () => {
  const hostile = {
    get id(): string {
      throw new Error("boom");
    },
  };
  assert.equal(recoverRendererResponseId(hostile), null);
});

test("the malformed-renderer-response error code is stable", () => {
  assert.equal(BRIDGE_MALFORMED_RENDERER_RESPONSE, "BRIDGE_MALFORMED_RENDERER_RESPONSE");
});
