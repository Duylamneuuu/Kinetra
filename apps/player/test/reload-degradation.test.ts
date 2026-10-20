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
  assert.notEqual(fields.droppedRootMotion, dropped, "the reply must not alias the runtime record");
  assert.deepEqual(Object.keys(fields.droppedRootMotion ?? {}), ["__proto__"]);
  assert.equal(Object.getOwnPropertyDescriptor(fields.droppedRootMotion, "__proto__")?.value, "gone");
});

test("editing the reply or the log does not change the runtime record", () => {
  const dropped = { hero: "root bone gone" };
  const chains = { hero: ["leftArm"] };
  const result = { success: true as const, droppedRootMotion: dropped, droppedIkChains: chains };
  const fields = reloadDegradationFields(result);
  const logs = reloadDegradationLogs("asset_hero", result);

  const replyRoot = fields.droppedRootMotion;
  const replyChains = fields.droppedIkChains;
  assert.ok(replyRoot && replyChains);
  replyRoot.hero = "mutated";
  const replyNames = replyChains.hero;
  assert.ok(replyNames);
  replyNames.push("rightArm");

  const loggedChains = logs.find((entry) => entry.message === "animation.ikChainsDropped");
  const loggedRoot = logs.find((entry) => entry.message === "animation.rootMotionDropped");
  assert.ok(loggedChains && loggedRoot);
  const loggedNames = (loggedChains.data.entities as Record<string, string[]>).hero;
  assert.ok(loggedNames);
  loggedNames.push("spine");

  assert.equal(dropped.hero, "root bone gone");
  assert.deepEqual(chains.hero, ["leftArm"]);
  assert.equal((loggedRoot.data.entities as Record<string, string>).hero, "root bone gone");
});
