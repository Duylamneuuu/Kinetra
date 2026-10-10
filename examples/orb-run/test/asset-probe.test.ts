import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { hashBytes } from "@kinetra/asset-pipeline";
import { createSyntheticWav } from "@kinetra/audio";
import { AcceptanceRunner, acceptanceManifestSchema, type AcceptanceManifest } from "@kinetra/verification";

import {
  ORB_RUN_ASSET_FAILURE_LOG_LIMIT,
  ORB_RUN_ASSET_IDS,
  ORB_RUN_AUDIO_ASSET,
  ORB_RUN_MODEL_ASSET,
  ORB_RUN_SCENE_ID,
  OrbRunAssetCatalog,
  OrbRunHeadlessProbe,
  createOrbRunAssetsManifest,
  createOrbRunModelBytes,
} from "../src/index.js";

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

function manifest(steps: unknown[]): AcceptanceManifest {
  return acceptanceManifestSchema.parse({ schemaVersion: 1, suite: "orb-run.assets.inline", steps });
}

function firstFailure(report: Awaited<ReturnType<AcceptanceRunner["run"]>>): string {
  const failed = report.steps.find((step) => !step.passed);
  return failed ? `step ${failed.index} (${failed.type}): ${failed.message ?? ""}` : "no failed step";
}

test("assets.acceptance.json passes on the engine AcceptanceRunner", async () => {
  const url = new URL("../../acceptance/assets.acceptance.json", import.meta.url);
  const loaded = acceptanceManifestSchema.parse(JSON.parse(await readFile(url, "utf8")));
  const probe = new OrbRunHeadlessProbe();
  const report = await new AcceptanceRunner(probe).run(loaded);
  assert.equal(report.passed, true, firstFailure(report));
  assert.equal(report.steps.length, loaded.steps.length, "every step ran");
});

test("assets.acceptance.json is in sync with the content generators (regenerate with `pnpm snapshot`)", async () => {
  const url = new URL("../../acceptance/assets.acceptance.json", import.meta.url);
  const committed = JSON.parse(await readFile(url, "utf8")) as unknown;
  assert.deepEqual(committed, JSON.parse(JSON.stringify(await createOrbRunAssetsManifest())));
});

test("the manifest gate has teeth: a stale fingerprint literal fails it", async () => {
  const url = new URL("../../acceptance/assets.acceptance.json", import.meta.url);
  const raw = JSON.parse(await readFile(url, "utf8")) as { steps: Array<Record<string, unknown>> };
  const index = raw.steps.findIndex((s) => typeof s.path === "string" && s.path.endsWith(".fingerprint"));
  assert.ok(index > 0);
  raw.steps[index] = { ...raw.steps[index], expected: "0".repeat(64) };
  const report = await new AcceptanceRunner(new OrbRunHeadlessProbe()).run(acceptanceManifestSchema.parse(raw));
  assert.equal(report.passed, false);
  assert.equal(report.steps.find((s) => !s.passed)?.index, index);
});

test("state.assets lists every shipped asset with its metadata before anything is edited", async () => {
  const probe = new OrbRunHeadlessProbe();
  await probe.start(ORB_RUN_SCENE_ID, 0);
  const assets = (await probe.snapshot()).state.assets as ReturnType<OrbRunAssetCatalog["state"]>;
  assert.deepEqual(Object.keys(assets.byId).sort(), [...ORB_RUN_ASSET_IDS].sort());
  assert.equal(assets.count, ORB_RUN_ASSET_IDS.length);
  assert.equal(assets.importedCount, ORB_RUN_ASSET_IDS.length);
  assert.equal(assets.errorCount + assets.warningCount + assets.failedCount + assets.reimportCount, 0);
  for (const row of Object.values(assets.byId)) {
    assert.equal(row.importStatus, "imported");
    assert.equal(row.revision, 1);
    assert.match(row.fingerprint, /^[a-f0-9]{64}$/);
    assert.match(row.sourceHash, /^[a-f0-9]{64}$/);
    assert.ok(row.bytes > 44);
  }
  assert.deepEqual(assets.byId[ORB_RUN_MODEL_ASSET.player]!.dimensions, [0.6, 1.7, 0.6]);
  await probe.close();
});

test("snapshots are deterministic across probes (fingerprints and hashes included)", async () => {
  const observe = async () => {
    const probe = new OrbRunHeadlessProbe();
    await probe.start(ORB_RUN_SCENE_ID, 0);
    await probe.input({ action: "player.moveRight", phase: "hold", durationMs: 2000 });
    const snapshot = await probe.snapshot();
    await probe.close();
    return snapshot;
  };
  assert.deepEqual(await observe(), await observe());
});

test("an edit registered before runtime.start is already live at the first frame; a plain restart begins from the shipped content", async () => {
  const edited = await createOrbRunModelBytes(ORB_RUN_MODEL_ASSET.orb, { color: [0.2, 0.9, 0.2, 1] });
  const report = await new AcceptanceRunner(new OrbRunHeadlessProbe()).run(
    manifest([
      { type: "runtime.start", sceneId: ORB_RUN_SCENE_ID, assets: { [ORB_RUN_MODEL_ASSET.orb]: b64(edited) } },
      { type: "assert.equal", path: `state.assets.byId.${ORB_RUN_MODEL_ASSET.orb}.revision`, expected: 2 },
      { type: "assert.equal", path: `state.assets.byId.${ORB_RUN_MODEL_ASSET.orb}.sourceHash`, expected: hashBytes(edited) },
      { type: "runtime.stop" },
      { type: "runtime.start", sceneId: ORB_RUN_SCENE_ID },
      { type: "assert.equal", path: "state.assets.reimportCount", expected: 0 },
      { type: "assert.equal", path: `state.assets.byId.${ORB_RUN_MODEL_ASSET.orb}.revision`, expected: 1 },
      { type: "assert.equal", path: "state.game.step", expected: 0 },
      { type: "runtime.stop" },
    ]),
  );
  assert.equal(report.passed, true, firstFailure(report));
});

test("one probe can run several manifests in a row: asset edits and failures do not leak into the next run (#262)", async () => {
  const probe = new OrbRunHeadlessProbe();
  const edited = await createOrbRunModelBytes(ORB_RUN_MODEL_ASSET.orb, { color: [0.2, 0.9, 0.2, 1] });
  const dirty = await new AcceptanceRunner(probe).run(
    manifest([
      { type: "runtime.start", sceneId: ORB_RUN_SCENE_ID },
      { type: "asset.register", assetId: ORB_RUN_MODEL_ASSET.orb, dataBase64: b64(edited) },
      { type: "assert.equal", path: "state.assets.reimportCount", expected: 1 },
      { type: "asset.register", assetId: ORB_RUN_MODEL_ASSET.player, dataBase64: b64(new Uint8Array([1, 2, 3, 4])) },
      { type: "assert.equal", path: "state.assets.failedCount", expected: 1 },
      { type: "runtime.stop" },
    ]),
  );
  assert.equal(dirty.passed, true, firstFailure(dirty));

  // The pinned manifest of slice 9 expects revision 1 everywhere; it only passes on pristine content.
  const url = new URL("../../acceptance/assets.acceptance.json", import.meta.url);
  const pinned = acceptanceManifestSchema.parse(JSON.parse(await readFile(url, "utf8")));
  const clean = await new AcceptanceRunner(probe).run(pinned);
  assert.equal(clean.passed, true, firstFailure(clean));

  const pristine = await new AcceptanceRunner(probe).run(
    manifest([
      { type: "runtime.start", sceneId: ORB_RUN_SCENE_ID },
      { type: "assert.equal", path: "state.assets.reimportCount", expected: 0 },
      { type: "assert.equal", path: "state.assets.failedCount", expected: 0 },
      { type: "runtime.stop" },
    ]),
  );
  assert.equal(pristine.passed, true, firstFailure(pristine));
  // The first manifest's failure warning is still history on the probe (like simulation logs), not state.
  const warnings = (await probe.logs()).filter((log) => log.message === "asset.reimportFailed");
  assert.ok(warnings.length >= 1);
  await probe.close();
});

test("catalog: the failure log keeps only the most recent entries", async () => {
  const catalog = await OrbRunAssetCatalog.create();
  const id = ORB_RUN_MODEL_ASSET.exitPad;
  const total = ORB_RUN_ASSET_FAILURE_LOG_LIMIT + 5;
  for (let i = 0; i < total; i += 1) await catalog.replaceSource(id, new Uint8Array([i % 256, 1, 2, 3]));
  const failures = catalog.failures();
  assert.equal(failures.length, ORB_RUN_ASSET_FAILURE_LOG_LIMIT);
  assert.equal(catalog.state().failedCount, 1, "the asset is still reported failed");
  const good = await createOrbRunModelBytes(id);
  await catalog.replaceSource(id, good);
  assert.equal(catalog.state().failedCount, 0);
  assert.equal(catalog.failures().length, ORB_RUN_ASSET_FAILURE_LOG_LIMIT);
});

test("registering the unchanged source is a no-op: no new revision, no failure", async () => {
  const same = await createOrbRunModelBytes(ORB_RUN_MODEL_ASSET.exitPad);
  const report = await new AcceptanceRunner(new OrbRunHeadlessProbe()).run(
    manifest([
      { type: "runtime.start", sceneId: ORB_RUN_SCENE_ID },
      { type: "asset.register", assetId: ORB_RUN_MODEL_ASSET.exitPad, dataBase64: b64(same) },
      { type: "assert.equal", path: `state.assets.byId.${ORB_RUN_MODEL_ASSET.exitPad}.revision`, expected: 1 },
      { type: "assert.equal", path: "state.assets.reimportCount", expected: 0 },
      { type: "assert.logAbsent", minimumLevel: "warning" },
      { type: "runtime.stop" },
    ]),
  );
  assert.equal(report.passed, true, firstFailure(report));
});

test("an unknown asset id or invalid base64 fails the manifest instead of passing silently", async () => {
  const unknown = await new AcceptanceRunner(new OrbRunHeadlessProbe()).run(
    manifest([
      { type: "runtime.start", sceneId: ORB_RUN_SCENE_ID },
      { type: "asset.register", assetId: "asset_orbrun_model_typo", dataBase64: b64(new Uint8Array(4)) },
    ]),
  );
  assert.equal(unknown.passed, false);
  assert.match(unknown.steps[1]?.message ?? "", /Unknown Orb Run asset "asset_orbrun_model_typo"/);

  const garbage = await new AcceptanceRunner(new OrbRunHeadlessProbe()).run(
    manifest([
      { type: "runtime.start", sceneId: ORB_RUN_SCENE_ID },
      { type: "asset.register", assetId: ORB_RUN_MODEL_ASSET.orb, dataBase64: "not base64!!" },
    ]),
  );
  assert.equal(garbage.passed, false);
  assert.match(garbage.steps[1]?.message ?? "", /not valid base64/);
});

test("a corrupt source keeps the last good artifact, logs a warning that outlives stop(), and is visible in metrics", async () => {
  const probe = new OrbRunHeadlessProbe();
  await probe.start(ORB_RUN_SCENE_ID, 0);
  const id = ORB_RUN_MODEL_ASSET.player;
  const catalog = await probe.assets();
  const good = catalog.state().byId[id]!;
  await probe.registerAsset(id, b64(new Uint8Array([1, 2, 3, 4])));

  const row = ((await probe.snapshot()).state.assets as ReturnType<OrbRunAssetCatalog["state"]>).byId[id]!;
  assert.equal(row.importStatus, "failed");
  assert.match(row.error ?? "", /Import or validation failed/);
  assert.equal(row.fingerprint, good.fingerprint);
  assert.equal(row.bytes, good.bytes, "the last good artifact is still there");

  assert.equal((await probe.metrics())["assets.failures"], 1);
  await probe.stop();
  const warnings = (await probe.logs()).filter((log) => log.message === "asset.reimportFailed");
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0]!.level, "warning");
  assert.equal(warnings[0]!.data?.assetId, id);
  await probe.close();
});

test("catalog: a WAV at another sample rate imports with a warning that state.assets counts", async () => {
  const catalog = await OrbRunAssetCatalog.create();
  const id = ORB_RUN_AUDIO_ASSET.lose;
  const wav = createSyntheticWav({ frequency: 130.81, durationSeconds: 0.5, sampleRate: 44100 });
  const result = await catalog.replaceSource(id, wav);
  assert.equal(result.status, "reimported");
  const state = catalog.state();
  assert.equal(state.warningCount, 1);
  assert.equal(state.byId[id]!.sampleRateHz, 44100);
  assert.equal(state.errorCount, 0);
});

test("catalog: cues without a registered asset are counted, and unknown ids are rejected", async () => {
  const catalog = await OrbRunAssetCatalog.create();
  assert.equal(catalog.state([ORB_RUN_AUDIO_ASSET.win, "asset_missing", "asset_missing_2"]).unregisteredCues, 2);
  assert.equal(catalog.has(ORB_RUN_AUDIO_ASSET.win), true);
  assert.equal(catalog.has("asset_missing"), false);
  await assert.rejects(catalog.replaceSource("asset_missing", new Uint8Array(1)), /Unknown Orb Run asset/);
});

test("catalog: failure heals when the good source comes back, and the failure stays in the log", async () => {
  const catalog = await OrbRunAssetCatalog.create();
  const id = ORB_RUN_MODEL_ASSET.exitPad;
  const good = await createOrbRunModelBytes(id);
  await catalog.replaceSource(id, good.slice(0, 12));
  assert.equal(catalog.state().failedCount, 1);
  await catalog.replaceSource(id, good);
  assert.equal(catalog.state().failedCount, 0);
  assert.equal(catalog.state().byId[id]!.importStatus, "imported");
  assert.equal(catalog.failures().length, 1, "the failure event is history, not state");
});
