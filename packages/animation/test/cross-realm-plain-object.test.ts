import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import { normalizeAnimationEvents } from "../src/events.js";
import { buildMorphTargetCatalog, validateMorphWeightRequest } from "../src/morph-targets.js";

// Objects built inside another V8 context have that context's Object.prototype. A host that hands a
// parsed project or a request across such a boundary must not be rejected for it.
function foreign<T>(source: string): T {
  return vm.runInNewContext(`(${source})`) as T;
}

test("animation events: entries and payloads from another realm are accepted and deep-copied into this realm", () => {
  const raw = foreign<unknown>(`[{ clip: "walk", time: 0.5, name: "footstep", payload: { foot: "left", nested: { n: 1 } } }]`);
  const result = normalizeAnimationEvents(raw);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.events.length, 1);
  const payload = result.events[0]?.payload as Record<string, unknown>;
  assert.equal(payload.foot, "left");
  assert.equal(Object.getPrototypeOf(payload), Object.prototype, "the copy lives in this realm");
});

test("animation events: class instances and prototype-chained objects are still rejected", () => {
  class Entry {
    clip = "walk";
    time = 0;
    name = "x";
  }
  const base = { clip: "walk", time: 0, name: "x" };
  const chained = Object.create(base) as unknown;
  const chainedFromNullRoot = Object.create(Object.create(null)) as unknown;
  const foreignInstance = foreign<unknown>(`new (class Entry { constructor() { this.clip = "walk"; this.time = 0; this.name = "x"; } })()`);
  for (const [label, entry] of [
    ["class instance", new Entry()],
    ["Object.create(plain)", chained],
    ["Object.create(Object.create(null))", chainedFromNullRoot],
    ["foreign class instance", foreignInstance],
    ["foreign Map", foreign<unknown>("new Map()")],
    ["foreign Date", foreign<unknown>("new Date(0)")],
  ] as const) {
    const result = normalizeAnimationEvents([entry]);
    assert.equal(result.events.length, 0, `${label} must not become an event`);
    assert.ok(result.diagnostics.some((d) => d.code === "animation.events.invalidEvent"), label);
  }
});

test("animation events: a foreign payload that is not a plain object is rejected", () => {
  const raw = [{ clip: "walk", time: 0, name: "x", payload: foreign<unknown>("new Map()") }];
  const result = normalizeAnimationEvents(raw);
  assert.equal(result.events.length, 0);
  assert.ok(result.diagnostics.some((d) => d.code === "animation.events.invalidPayload"));
});

test("morph weight request: an object from another realm is accepted, a foreign non-plain value is not", () => {
  const catalog = buildMorphTargetCatalog([{ meshName: "Face", targetNames: ["smile"], influences: [0] }]);
  const ok = validateMorphWeightRequest(foreign<unknown>(`({ smile: 0.5 })`), catalog);
  assert.equal(ok.ok, true);
  const nullProto = validateMorphWeightRequest(foreign<unknown>(`Object.assign(Object.create(null), { smile: 1 })`), catalog);
  assert.equal(nullProto.ok, true);
  for (const bad of [foreign<unknown>("new Map([['smile', 1]])"), foreign<unknown>("[1]"), foreign<unknown>("new Date(0)"), Object.create(Object.create(null))]) {
    const result = validateMorphWeightRequest(bad, catalog);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.diagnostics[0]?.code, "anim.morph.invalidRequest");
  }
});
