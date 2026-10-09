import { hashBytes } from "@kinetra/asset-pipeline";

import { ORB_RUN_AUDIO_ASSET, ORB_RUN_AUDIO_ASSET_IDS } from "./audio.js";
import {
  ORB_RUN_MODEL_ASSET,
  ORB_RUN_MODEL_ASSET_IDS,
  OrbRunAssetCatalog,
  createOrbRunModelBytes,
} from "./assets.js";
import { ORB_RUN_SCENE_ID } from "./ids.js";

/** The colour an artist repaints the orb in `assets.acceptance.json`. */
export const ORB_RUN_EDITED_ORB_COLOR: [number, number, number, number] = [0.9, 0.1, 0.1, 1];

const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

/**
 * Builds `acceptance/assets.acceptance.json`: the content gate for Orb Run.
 *
 * The manifest first checks everything the game ships is imported and valid,
 * then plays the first orb pickup, hot-reimports an edited orb, survives a
 * corrupt player source (last good artifact kept, failure reported), heals it,
 * and finishes the game with no cue that lacks an asset. Fingerprints and
 * hashes are literals computed here from the same deterministic generators, so
 * a change to the content or the importer shows up as a manifest diff (the
 * test `assets.acceptance.json is in sync` guards it; regenerate with
 * `pnpm --filter @kinetra/example-orb-run snapshot`).
 */
export async function createOrbRunAssetsManifest(): Promise<Record<string, unknown>> {
  const orb = ORB_RUN_MODEL_ASSET.orb;
  const player = ORB_RUN_MODEL_ASSET.player;
  const pickup1 = ORB_RUN_AUDIO_ASSET.pickups[0]!;

  const baseline = await OrbRunAssetCatalog.create();
  const baselineState = baseline.state();
  const playerFingerprint = baselineState.byId[player]!.fingerprint;
  const playerGood = await createOrbRunModelBytes(player);
  const playerCorrupt = playerGood.slice(0, 20);
  const orbEdited = await createOrbRunModelBytes(orb, { color: ORB_RUN_EDITED_ORB_COLOR });

  const edited = await OrbRunAssetCatalog.create();
  await edited.replaceSource(orb, orbEdited);
  const editedOrb = edited.state().byId[orb]!;

  const eq = (path: string, expected: unknown) => ({ type: "assert.equal", path, expected });
  const near = (path: string, expected: number) => ({ type: "assert.near", path, expected, tolerance: 0.000001 });
  const hold = (action: string, durationMs: number) => ({ type: "input", action, phase: "hold", durationMs });

  return {
    schemaVersion: 1,
    suite: "orb-run.assets",
    seed: 0,
    target: "runtime",
    steps: [
      { type: "runtime.start", sceneId: ORB_RUN_SCENE_ID },
      eq("state.assets.count", ORB_RUN_MODEL_ASSET_IDS.length + ORB_RUN_AUDIO_ASSET_IDS.length),
      eq("state.assets.modelCount", ORB_RUN_MODEL_ASSET_IDS.length),
      eq("state.assets.audioCount", ORB_RUN_AUDIO_ASSET_IDS.length),
      eq("state.assets.importedCount", ORB_RUN_MODEL_ASSET_IDS.length + ORB_RUN_AUDIO_ASSET_IDS.length),
      eq("state.assets.failedCount", 0),
      eq("state.assets.errorCount", 0),
      eq("state.assets.warningCount", 0),
      eq("state.assets.reimportCount", 0),
      eq("state.assets.unregisteredCues", 0),
      eq(`state.assets.byId.${orb}.revision`, 1),
      eq(`state.assets.byId.${orb}.polycount`, 12),
      near(`state.assets.byId.${orb}.dimensions.0`, 0.6),
      near(`state.assets.byId.${ORB_RUN_MODEL_ASSET.exitPad}.dimensions.0`, 2),
      eq(`state.assets.byId.${ORB_RUN_AUDIO_ASSET.win}.sampleRateHz`, 22050),
      near(`state.assets.byId.${ORB_RUN_AUDIO_ASSET.win}.durationSeconds`, 0.6),

      hold("player.moveRight", 2000),
      eq("state.game.collectedCount", 1),
      eq(`state.audio.played.${pickup1}`, 1),
      eq("state.assets.unregisteredCues", 0),

      { type: "asset.register", assetId: orb, dataBase64: toBase64(orbEdited) },
      eq(`state.assets.byId.${orb}.importStatus`, "imported"),
      eq(`state.assets.byId.${orb}.revision`, 2),
      eq(`state.assets.byId.${orb}.sourceHash`, hashBytes(orbEdited)),
      eq(`state.assets.byId.${orb}.fingerprint`, editedOrb.fingerprint),
      eq("state.assets.reimportCount", 1),
      eq(`state.assets.byId.${player}.revision`, 1),
      eq("state.game.collectedCount", 1),

      { type: "asset.register", assetId: player, dataBase64: toBase64(playerCorrupt) },
      eq(`state.assets.byId.${player}.importStatus`, "failed"),
      eq(`state.assets.byId.${player}.revision`, 1),
      eq(`state.assets.byId.${player}.fingerprint`, playerFingerprint),
      eq("state.assets.failedCount", 1),
      eq("state.assets.errorCount", 0),
      eq("state.assets.importedCount", ORB_RUN_MODEL_ASSET_IDS.length + ORB_RUN_AUDIO_ASSET_IDS.length - 1),

      { type: "asset.register", assetId: player, dataBase64: toBase64(playerGood) },
      eq(`state.assets.byId.${player}.importStatus`, "imported"),
      eq(`state.assets.byId.${player}.revision`, 1),
      eq("state.assets.failedCount", 0),

      hold("player.moveLeft", 1000),
      hold("player.moveBackward", 1000),
      hold("player.moveLeft", 1000),
      hold("player.moveBackward", 1000),
      { type: "wait", milliseconds: 100 },
      hold("player.moveRight", 2000),
      { type: "wait", milliseconds: 100 },
      eq("state.game.status", "won"),
      eq("state.audio.playedCount", 5),
      eq("state.assets.unregisteredCues", 0),
      eq("state.assets.errorCount", 0),
      { type: "assert.metricMin", metric: "assets.count", min: ORB_RUN_MODEL_ASSET_IDS.length + ORB_RUN_AUDIO_ASSET_IDS.length },
      { type: "assert.metricMax", metric: "assets.failures", max: 1 },
      { type: "assert.logAbsent", minimumLevel: "error" },
      { type: "runtime.stop" },
    ],
  };
}
