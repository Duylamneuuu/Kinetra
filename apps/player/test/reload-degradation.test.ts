import assert from "node:assert/strict";
import test from "node:test";

import { reloadDegradationFields, reloadDegradationLogs } from "../src/reload-degradation.js";

test("a clean reload produces no log entries and no reply fields", () => {
  assert.deepEqual(reloadDegradationLogs("a", {}), []);
  assert.deepEqual(reloadDegradationFields({ success: true }), {});
});

test("empty maps are treated as clean", () => {
  const empty = { droppedRootMotion: {}, droppedIkChains: {}, droppedMorphOverrides: {} };
  assert.deepEqual(reloadDegradationLogs("a", empty), []);
  assert.deepEqual(reloadDegradationFields({ success: true, ...empty }), {});
});

test("each dropped feature gets its own warning entry in a stable order", () => {
  const logs = reloadDegradationLogs("asset_hero", {
    droppedRootMotion: { hero: "root bone gone" },
    droppedIkChains: { hero: ["leftArm"] },
    droppedMorphOverrides: { npc: ["smile"] },
  });
  assert.deepEqual(
    logs.map((l) => l.message),
    ["animation.morphOverridesDropped", "animation.ikChainsDropped", "animation.rootMotionDropped"],
  );
  assert.deepEqual(logs[2]?.data, { assetId: "asset_hero", entities: { hero: "root bone gone" } });
  assert.deepEqual(logs[1]?.data.entities, { hero: ["leftArm"] });
});

test("only the kinds that were dropped appear", () => {
  const logs = reloadDegradationLogs("a", { droppedRootMotion: { e: "x" } });
  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.message, "animation.rootMotionDropped");
});

test("reply fields carry the non-empty maps of a successful reload", () => {
  const fields = reloadDegradationFields({
    success: true,
    droppedRootMotion: { hero: "root bone gone" },
    droppedIkChains: {},
    droppedMorphOverrides: { npc: ["smile"] },
  });
  assert.deepEqual(fields, { droppedRootMotion: { hero: "root bone gone" }, droppedMorphOverrides: { npc: ["smile"] } });
  assert.ok(!("droppedIkChains" in fields));
});

test("a failed reload never reports dropped features", () => {
  assert.deepEqual(reloadDegradationFields({ success: false, droppedRootMotion: { hero: "stale" } }), {});
});

test("entity ids that look like prototype keys stay own keys", () => {
  const dropped = JSON.parse('{"__proto__": "gone"}') as Record<string, string>;
  const fields = reloadDegradationFields({ success: true, droppedRootMotion: dropped });
  assert.equal(fields.droppedRootMotion, dropped, "the same record object is forwarded unmodified");
  assert.deepEqual(Object.keys(fields.droppedRootMotion ?? {}), ["__proto__"]);
});
