import assert from "node:assert/strict";
import test from "node:test";

import { parseBridgeLine } from "../electron/bridge-protocol.js";

function failureOf(line: string) {
  const parsed = parseBridgeLine(line);
  assert.equal(parsed.ok, false, `expected a failure for ${line}`);
  if (parsed.ok) throw new Error("unreachable");
  return parsed.response;
}

test("a valid request parses with and without params", () => {
  const withParams = parseBridgeLine(
    JSON.stringify({ id: "1", method: "ping", params: { a: 1 } }),
  );
  assert.deepEqual(withParams, {
    ok: true,
    request: { id: "1", method: "ping", params: { a: 1 } },
  });

  const bare = parseBridgeLine('{"id":"2","method":"runtime.start"}');
  assert.deepEqual(bare, {
    ok: true,
    request: { id: "2", method: "runtime.start" },
  });
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      (bare as { request: object }).request,
      "params",
    ),
    false,
  );
});

test("falsy but defined params survive (null, 0, false, empty string)", () => {
  for (const params of [null, 0, false, ""]) {
    const parsed = parseBridgeLine(JSON.stringify({ id: "x", method: "m", params }));
    assert.equal(parsed.ok, true);
    if (parsed.ok) assert.deepEqual(parsed.request.params, params);
  }
});

test("unknown extra fields are ignored", () => {
  const parsed = parseBridgeLine('{"id":"1","method":"m","extra":true}');
  assert.deepEqual(parsed, { ok: true, request: { id: "1", method: "m" } });
});

test("a request without a method gets a structured failure that keeps its id", () => {
  const response = failureOf('{"id":"abc"}');
  assert.equal(response.type, "response");
  assert.equal(response.ok, false);
  assert.equal(response.id, "abc");
  assert.equal(response.code, "BRIDGE_INVALID_METHOD");
  assert.match(response.error, /^BRIDGE_INVALID_METHOD: /);
});

test("a non-string method gets BRIDGE_INVALID_METHOD with the id preserved", () => {
  for (const method of [null, 7, true, {}, [], ["ping"]]) {
    const response = failureOf(JSON.stringify({ id: "m1", method }));
    assert.equal(response.code, "BRIDGE_INVALID_METHOD");
    assert.equal(response.id, "m1");
  }
});

test("a missing or non-string id cannot be echoed, so the failure carries a null id", () => {
  for (const line of [
    '{"method":"ping"}',
    '{"id":5,"method":"ping"}',
    '{"id":null,"method":"ping"}',
    '{"id":{"n":1},"method":"ping"}',
    "{}",
  ]) {
    const response = failureOf(line);
    assert.equal(response.id, null, line);
    assert.equal(response.code, "BRIDGE_INVALID_ID", line);
    assert.equal(response.ok, false);
  }
});

test("an empty-string id and method still parse (the dispatcher rejects unknown methods itself)", () => {
  assert.deepEqual(parseBridgeLine('{"id":"","method":""}'), {
    ok: true,
    request: { id: "", method: "" },
  });
});

test("non-object JSON is BRIDGE_INVALID_REQUEST", () => {
  for (const line of ["[]", "[1,2]", "42", '"text"', "null", "true"]) {
    const response = failureOf(line);
    assert.equal(response.code, "BRIDGE_INVALID_REQUEST", line);
    assert.equal(response.id, null);
  }
});

test("malformed JSON is BRIDGE_INVALID_JSON and never throws", () => {
  for (const line of ["{", "not json", '{"id":"1","method":', "{'id':'1'}", "\u0000"]) {
    const response = failureOf(line);
    assert.equal(response.code, "BRIDGE_INVALID_JSON", line);
    assert.equal(response.id, null);
    assert.ok(response.error.length > "BRIDGE_INVALID_JSON: ".length);
  }
});

test("failure responses are one-line JSON the verification client can read", () => {
  const response = failureOf('{"id":"q"}');
  const wire = JSON.stringify(response);
  assert.equal(wire.includes("\n"), false);
  const roundTrip = JSON.parse(wire) as Record<string, unknown>;
  assert.equal(roundTrip.type, "response");
  assert.equal(roundTrip.ok, false);
  assert.equal(roundTrip.id, "q");
  assert.equal(typeof roundTrip.error, "string");
});

test("property: parseBridgeLine never throws and every failure is a well-formed response", () => {
  let seed = 20260610;
  const next = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  const scalars: unknown[] = [null, true, false, 0, -1, 1.5, "", "id", "ping", [], {}, [1], { a: 1 }];
  for (let i = 0; i < 400; i += 1) {
    const object: Record<string, unknown> = {};
    for (const key of ["id", "method", "params", "type", "extra"]) {
      if (next() < 0.6) object[key] = scalars[Math.floor(next() * scalars.length)];
    }
    const line = next() < 0.1 ? JSON.stringify(object).slice(0, 7) : JSON.stringify(object);
    const parsed = parseBridgeLine(line);
    if (parsed.ok) {
      assert.equal(typeof parsed.request.id, "string");
      assert.equal(typeof parsed.request.method, "string");
    } else {
      assert.equal(parsed.response.type, "response");
      assert.equal(parsed.response.ok, false);
      assert.ok(parsed.response.id === null || typeof parsed.response.id === "string");
      assert.match(parsed.response.code, /^BRIDGE_INVALID_(JSON|REQUEST|ID|METHOD)$/);
      assert.ok(parsed.response.error.startsWith(`${parsed.response.code}: `));
    }
  }
});
