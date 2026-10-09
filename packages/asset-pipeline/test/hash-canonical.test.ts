import assert from "node:assert/strict";
import test from "node:test";

import { CanonicalJsonError, hashJson, importFingerprint } from "../src/index.js";

function parse(text: string): unknown {
  return JSON.parse(text);
}

test("hashJson ignores key order at every depth", () => {
  assert.equal(
    hashJson({ b: 1, a: { y: [1, { q: 1, p: 2 }], x: "s" } }),
    hashJson({ a: { x: "s", y: [1, { p: 2, q: 1 }] }, b: 1 }),
  );
});

test("hashJson keeps array order and distinguishes types", () => {
  assert.notEqual(hashJson([1, 2]), hashJson([2, 1]));
  assert.notEqual(hashJson({ a: 1 }), hashJson({ a: "1" }));
  assert.notEqual(hashJson({ a: null }), hashJson({}));
  assert.notEqual(hashJson({ a: [] }), hashJson({ a: {} }));
});

test("an own __proto__ key changes the fingerprint instead of being dropped", () => {
  const withProto = parse('{"__proto__":{"polluted":true}}');
  assert.notEqual(hashJson(withProto), hashJson({}));
  assert.notEqual(hashJson(withProto), hashJson(parse('{"__proto__":{"polluted":false}}')));
  assert.notEqual(
    importFingerprint({ sourceHash: "s", importer: "i", importerVersion: "1", settings: parse('{"__proto__":{"a":1}}') as Record<string, unknown> }),
    importFingerprint({ sourceHash: "s", importer: "i", importerVersion: "1", settings: {} }),
  );
  assert.equal(({} as { polluted?: boolean }).polluted, undefined, "hashing never pollutes Object.prototype");
});

test("non-finite numbers are rejected rather than hashed as null", () => {
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.throws(
      () => hashJson({ settings: { scale: value } }),
      (error: unknown) =>
        error instanceof CanonicalJsonError && error.code === "hash.nonFiniteNumber" && error.path === "$.settings.scale",
    );
  }
  assert.throws(() => hashJson([1, Number.NaN]), (error: unknown) => error instanceof CanonicalJsonError && error.path === "$[1]");
  assert.equal(hashJson({ a: 0 }), hashJson({ a: -0 }), "-0 and 0 serialize identically in JSON");
});

test("values JSON cannot represent are rejected, undefined properties are treated as absent", () => {
  for (const value of [1n, () => 1, Symbol("s")]) {
    assert.throws(
      () => hashJson({ a: value }),
      (error: unknown) => error instanceof CanonicalJsonError && error.code === "hash.unsupportedValue",
    );
  }
  assert.throws(() => hashJson([undefined]), (error: unknown) => error instanceof CanonicalJsonError && error.path === "$[0]");
  assert.equal(hashJson({ a: 1, b: undefined }), hashJson({ a: 1 }));
});

test("circular structures raise a structured error, shared references do not", () => {
  const loop: Record<string, unknown> = { name: "loop" };
  loop.self = loop;
  assert.throws(
    () => hashJson(loop),
    (error: unknown) => error instanceof CanonicalJsonError && error.code === "hash.cycle" && error.path === "$.self",
  );

  const shared = { v: 1 };
  assert.equal(hashJson({ a: shared, b: shared }), hashJson({ a: { v: 1 }, b: { v: 1 } }));
});

test("Date and other toJSON values hash by their JSON form, not as empty objects", () => {
  const first = new Date("2026-01-01T00:00:00.000Z");
  const second = new Date("2026-06-01T00:00:00.000Z");
  assert.notEqual(hashJson({ at: first }), hashJson({ at: second }));
  assert.equal(hashJson({ at: first }), hashJson({ at: first.toISOString() }));
});

test("importFingerprint is stable under dependency and settings reordering", () => {
  const base = { sourceHash: "abc", importer: "gltf", importerVersion: "1" };
  assert.equal(
    importFingerprint({ ...base, settings: { a: 1, b: 2 }, dependencyFingerprints: ["x", "y"] }),
    importFingerprint({ ...base, settings: { b: 2, a: 1 }, dependencyFingerprints: ["y", "x"] }),
  );
  assert.notEqual(
    importFingerprint({ ...base, settings: { a: 1 } }),
    importFingerprint({ ...base, settings: { a: 2 } }),
  );
  assert.notEqual(
    importFingerprint({ ...base, settings: {} }),
    importFingerprint({ ...base, settings: {}, dependencyFingerprints: ["x"] }),
  );
});

test("seeded fuzz: equal canonical structures hash equal, and any single leaf change alters the hash", () => {
  let seed = 20261009;
  const next = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  const build = (depth: number): unknown => {
    const roll = next();
    if (depth === 0 || roll < 0.35) {
      const leaf = next();
      return leaf < 0.3 ? Math.floor(next() * 1000) : leaf < 0.6 ? `s${Math.floor(next() * 1000)}` : leaf < 0.8 ? next() < 0.5 : null;
    }
    if (roll < 0.6) return Array.from({ length: Math.floor(next() * 4) }, () => build(depth - 1));
    const record: Record<string, unknown> = {};
    for (let index = 0; index < 1 + Math.floor(next() * 4); index += 1) record[`k${Math.floor(next() * 6)}`] = build(depth - 1);
    return record;
  };
  const shuffleKeys = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(shuffleKeys);
    if (value && typeof value === "object") {
      const entries = Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, shuffleKeys(v)] as const);
      entries.reverse();
      return Object.fromEntries(entries);
    }
    return value;
  };
  const mutateFirstLeaf = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        const mutated = mutateFirstLeaf(value[index]);
        if (mutated !== undefined) return value.map((item, at) => (at === index ? mutated : item));
      }
      return undefined;
    }
    if (value && typeof value === "object") {
      for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        const mutated = mutateFirstLeaf((value as Record<string, unknown>)[key]);
        if (mutated !== undefined) return { ...(value as Record<string, unknown>), [key]: mutated };
      }
      return undefined;
    }
    return typeof value === "number" ? value + 1 : typeof value === "string" ? `${value}!` : typeof value === "boolean" ? !value : { was: null };
  };

  let mutations = 0;
  for (let round = 0; round < 300; round += 1) {
    const value = build(4);
    assert.equal(hashJson(value), hashJson(shuffleKeys(value)), `round ${round}: key order must not matter`);
    assert.equal(hashJson(value), hashJson(structuredClone(value)), `round ${round}: clones hash equal`);
    const changed = mutateFirstLeaf(value);
    if (changed !== undefined) {
      mutations += 1;
      assert.notEqual(hashJson(value), hashJson(changed), `round ${round}: a leaf change must change the hash`);
    }
  }
  assert.ok(mutations > 100, "the fuzz exercised enough mutations");
});
