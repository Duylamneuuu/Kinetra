import assert from "node:assert/strict";
import test from "node:test";

import type { GameScriptContext } from "@kinetra/core";

import {
  ORB_RUN_DEFAULT_RULES,
  ORB_RUN_EVENT,
  ORB_RUN_PICKUP_ASSET_IDS,
  OrbRunManager,
} from "../src/index.js";

/**
 * `OrbRunManager.onEvent` ignores an `orbCollected` for an orb it already counted,
 * so a repeated or replayed event can neither double-count nor replay the pickup
 * cue (#187 item 5). Driven straight through the script contract with a recording
 * audio service, so the assertion is on what the manager asked to play.
 */
function createHarness() {
  const plays: Array<{ assetId: string; gain?: number }> = [];
  const context = {
    entityId: "orbrun-manager",
    audio: {
      play: async (request: { assetId: string; gain?: number }) => {
        plays.push({ assetId: request.assetId, ...(request.gain !== undefined ? { gain: request.gain } : {}) });
        return { success: true };
      },
    },
    log: () => undefined,
  } as unknown as GameScriptContext;
  const manager = new OrbRunManager({
    rules: ORB_RUN_DEFAULT_RULES,
    orbIds: ["orb-a", "orb-b", "orb-c"],
    exitEntityName: "Exit",
    playerEntityName: "Player",
  });
  return { manager, context, plays };
}

test("a repeated orbCollected for the same orb is counted and heard once", () => {
  const { manager, context, plays } = createHarness();
  manager.onEvent(ORB_RUN_EVENT.orbCollected, { orbId: "orb-a" }, context);
  manager.onEvent(ORB_RUN_EVENT.orbCollected, { orbId: "orb-a" }, context);
  manager.onEvent(ORB_RUN_EVENT.orbCollected, { orbId: "orb-a" }, context);

  assert.deepEqual(manager.getState().collectedOrbIds, ["orb-a"]);
  assert.equal(manager.getState().collectedCount, 1);
  assert.deepEqual(plays.map((play) => play.assetId), [ORB_RUN_PICKUP_ASSET_IDS[0]], "one pickup cue, not three");
});

test("a duplicate in the middle of a run does not shift the pickup ladder", () => {
  const { manager, context, plays } = createHarness();
  manager.onEvent(ORB_RUN_EVENT.orbCollected, { orbId: "orb-a" }, context);
  manager.onEvent(ORB_RUN_EVENT.orbCollected, { orbId: "orb-a" }, context);
  manager.onEvent(ORB_RUN_EVENT.orbCollected, { orbId: "orb-b" }, context);

  assert.equal(manager.getState().collectedCount, 2);
  assert.deepEqual(
    plays.map((play) => play.assetId),
    [ORB_RUN_PICKUP_ASSET_IDS[0], ORB_RUN_PICKUP_ASSET_IDS[1]],
    "the second distinct orb plays the second note",
  );
});

test("unknown, malformed and non-orb events change nothing and play nothing", () => {
  const { manager, context, plays } = createHarness();
  manager.onEvent(ORB_RUN_EVENT.orbCollected, { orbId: "orb-zzz" }, context);
  manager.onEvent(ORB_RUN_EVENT.orbCollected, { orbId: 7 }, context);
  manager.onEvent(ORB_RUN_EVENT.orbCollected, {}, context);
  manager.onEvent(ORB_RUN_EVENT.orbCollected, undefined, context);
  manager.onEvent(ORB_RUN_EVENT.orbCollected, null, context);
  manager.onEvent(ORB_RUN_EVENT.exitUnlocked, { orbId: "orb-a" }, context);

  assert.deepEqual(manager.getState().collectedOrbIds, []);
  assert.equal(manager.getState().collectedCount, 0);
  assert.deepEqual(plays, []);
});
