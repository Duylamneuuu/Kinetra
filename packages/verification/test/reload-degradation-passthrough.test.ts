import assert from "node:assert/strict";
import test from "node:test";

import { KinetraRuntimeProbe, type RuntimeProbeHost } from "../src/index.js";

const project = { id: "p" } as never;

function probeWith(result: unknown): KinetraRuntimeProbe {
  const host = {
    start: async () => undefined,
    stop: async () => undefined,
    close: async () => undefined,
    query: async () => ({ running: true, entities: [] }),
    readLogs: async () => [],
    reloadAsset: async () => result,
  } as unknown as RuntimeProbeHost;
  return new KinetraRuntimeProbe({ host, project });
}

test("reloadAsset hands the host's dropped-feature maps through unchanged", async () => {
  const reply = {
    success: true,
    affectedEntities: ["hero"],
    droppedRootMotion: { hero: "root bone gone" },
    droppedIkChains: { hero: ["leftArm"] },
    droppedMorphOverrides: { npc: ["smile"] },
  };
  const result = await probeWith(reply).reloadAsset("asset_hero");
  assert.deepEqual(result, reply);
  assert.equal(result.droppedRootMotion?.hero, "root bone gone");
  assert.deepEqual(result.droppedIkChains?.hero, ["leftArm"]);
  assert.deepEqual(result.droppedMorphOverrides?.npc, ["smile"]);
});

test("a reload without degradation has no dropped fields", async () => {
  const result = await probeWith({ success: true, affectedEntities: ["hero"] }).reloadAsset("a");
  assert.deepEqual(result, { success: true, affectedEntities: ["hero"] });
});
