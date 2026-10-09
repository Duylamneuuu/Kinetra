import assert from "node:assert/strict";
import test from "node:test";

import { AcceptanceRunner, acceptanceManifestSchema } from "@kinetra/verification";

import {
  HeadlessAudioService,
  HeadlessSceneSimulation,
  ORB_RUN_AUDIO_ASSET,
  ORB_RUN_AUDIO_ASSET_IDS,
  ORB_RUN_AUDIO_BUS,
  ORB_RUN_ENTITY,
  ORB_RUN_PICKUP_ASSET_IDS,
  ORB_RUN_SCENE_ID,
  ORB_RUN_WINNING_ROUTE,
  OrbRunHeadlessProbe,
  captureOrbRunSave,
  createOrbRunAudioBytes,
  createOrbRunMixer,
  createOrbRunProject,
  createOrbRunScriptRegistry,
  orbRunAudio,
  pickupAssetForCount,
  restoreOrbRunSave,
  startOrbRunSimulation,
  summarizeOrbRun,
  walkTo,
} from "../src/index.js";

function playRoute(simulation: HeadlessSceneSimulation): void {
  const finished = () => summarizeOrbRun(simulation).status !== "playing";
  for (const target of ORB_RUN_WINNING_ROUTE) {
    walkTo(simulation, target, { stopWhen: finished });
    if (finished()) return;
  }
  simulation.advance(1);
}

test("synthetic clips are valid mono 16-bit WAVs, one per asset id, and deterministic", () => {
  const first = createOrbRunAudioBytes();
  const second = createOrbRunAudioBytes();
  assert.deepEqual(Object.keys(first).sort(), [...ORB_RUN_AUDIO_ASSET_IDS]);
  for (const [assetId, bytes] of Object.entries(first)) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    assert.equal(String.fromCharCode(...bytes.slice(0, 4)), "RIFF", assetId);
    assert.equal(String.fromCharCode(...bytes.slice(8, 12)), "WAVE", assetId);
    assert.equal(view.getUint16(22, true), 1, `${assetId} mono`);
    assert.equal(view.getUint16(34, true), 16, `${assetId} 16-bit`);
    assert.deepEqual(bytes, second[assetId], `${assetId} is byte-identical across runs`);
  }
  assert.equal(new Set(ORB_RUN_PICKUP_ASSET_IDS.map((id) => first[id]!.byteLength)).size, 1);
  assert.notDeepEqual(first[ORB_RUN_PICKUP_ASSET_IDS[0]], first[ORB_RUN_PICKUP_ASSET_IDS[1]], "pitch ladder differs");
});

test("pickupAssetForCount climbs the ladder, clamps at the top, and rejects bad counts", () => {
  assert.equal(pickupAssetForCount(1), ORB_RUN_PICKUP_ASSET_IDS[0]);
  assert.equal(pickupAssetForCount(3), ORB_RUN_PICKUP_ASSET_IDS[2]);
  assert.equal(pickupAssetForCount(9), ORB_RUN_PICKUP_ASSET_IDS[2]);
  for (const bad of [0, -1, 1.5, Number.NaN]) assert.throws(() => pickupAssetForCount(bad), RangeError);
});

test("mixer layout: sfx and music hang off master and gain multiplies down the chain", () => {
  const mixer = createOrbRunMixer();
  assert.ok(mixer.hasBus(ORB_RUN_AUDIO_BUS.master) && mixer.hasBus(ORB_RUN_AUDIO_BUS.sfx) && mixer.hasBus(ORB_RUN_AUDIO_BUS.music));
  assert.equal(mixer.getBus(ORB_RUN_AUDIO_BUS.sfx)?.parentId, ORB_RUN_AUDIO_BUS.master);
  assert.ok(Math.abs(mixer.effectiveGain(ORB_RUN_AUDIO_BUS.sfx) - 0.9) < 1e-12);
  mixer.setGain(ORB_RUN_AUDIO_BUS.master, 0.5);
  assert.ok(Math.abs(mixer.effectiveGain(ORB_RUN_AUDIO_BUS.sfx) - 0.45) < 1e-12);
  mixer.setMuted(ORB_RUN_AUDIO_BUS.master, true);
  assert.equal(mixer.effectiveGain(ORB_RUN_AUDIO_BUS.sfx), 0, "muting the parent silences the child");
});

test("a winning run plays exactly: three rising pickups, the exit chime, then the win jingle", async () => {
  const simulation = await startOrbRunSimulation();
  try {
    const audio = orbRunAudio(simulation);
    assert.deepEqual(audio.cues(), [], "nothing plays before the run starts moving");
    playRoute(simulation);
    assert.equal(summarizeOrbRun(simulation).status, "won");
    assert.deepEqual(
      audio.cues().map((cue) => cue.assetId),
      [...ORB_RUN_PICKUP_ASSET_IDS, ORB_RUN_AUDIO_ASSET.exitUnlocked, ORB_RUN_AUDIO_ASSET.win],
    );
    assert.ok(audio.cues().every((cue) => cue.bus === ORB_RUN_AUDIO_BUS.sfx));
    assert.deepEqual(audio.failures(), []);
    const steps = audio.cues().map((cue) => cue.step);
    assert.deepEqual([...steps].sort((a, b) => a - b), steps, "cues are in simulation order");
    // Exit chime fires the step after the last pickup, never before the third orb.
    const [, , third, chime, win] = audio.cues();
    assert.ok(chime!.step >= third!.step);
    assert.ok(win!.step > chime!.step);
    // sfx bus is authored at 0.9; pickup gain 0.8 → 0.72, chime/win gain 1 → 0.9.
    assert.ok(Math.abs(audio.cues()[0]!.effectiveGainAtStart - 0.72) < 1e-12);
    assert.ok(Math.abs(win!.effectiveGainAtStart - 0.9) < 1e-12);
  } finally {
    await simulation.dispose();
  }
});

test("the win jingle never repeats after the run is finished", async () => {
  const simulation = await startOrbRunSimulation();
  try {
    playRoute(simulation);
    const before = orbRunAudio(simulation).cues().length;
    simulation.advance(300);
    assert.equal(orbRunAudio(simulation).cues().length, before, "a finished run is silent");
  } finally {
    await simulation.dispose();
  }
});

test("a timeout plays the lose cue and no win or chime", async () => {
  const simulation = await startOrbRunSimulation();
  try {
    simulation.advance(Math.ceil(60 / simulation.fixedDeltaSeconds));
    assert.equal(summarizeOrbRun(simulation).status, "lost");
    assert.deepEqual(
      orbRunAudio(simulation).cues().map((cue) => cue.assetId),
      [ORB_RUN_AUDIO_ASSET.lose],
    );
  } finally {
    await simulation.dispose();
  }
});

test("a muted sfx bus still starts cues (gameplay is unaffected) but they are inaudible", async () => {
  const simulation = await startOrbRunSimulation();
  try {
    const audio = orbRunAudio(simulation);
    audio.setBusMuted(ORB_RUN_AUDIO_BUS.sfx, true);
    playRoute(simulation);
    assert.equal(summarizeOrbRun(simulation).status, "won");
    assert.equal(audio.cues().length, 5);
    assert.ok(audio.cues().every((cue) => cue.effectiveGainAtStart === 0));
    assert.ok(audio.state().activePlaybacks.every((playback) => playback.muted));
  } finally {
    await simulation.dispose();
  }
});

test("playback progresses on the simulation clock and ends after the clip duration", async () => {
  const simulation = await startOrbRunSimulation();
  try {
    const audio = orbRunAudio(simulation);
    const result = await audio.play({ assetId: ORB_RUN_AUDIO_ASSET.win, bus: ORB_RUN_AUDIO_BUS.sfx });
    assert.equal(result.success, true);
    assert.equal(audio.state().activePlaybacks[0]?.playing, true);
    simulation.advance(9); // 0.3s of a 0.6s clip
    const mid = audio.state().activePlaybacks[0]!;
    assert.equal(mid.playing, true);
    assert.ok(Math.abs(mid.currentTime! - 0.3) < 1e-9);
    simulation.advance(9);
    assert.equal(audio.state().activePlaybacks[0]?.playing, false, "0.6s elapsed → ended");
  } finally {
    await simulation.dispose();
  }
});

test("play refuses unknown buses and assets with a recorded failure, and stop silences loops", async () => {
  const simulation = await startOrbRunSimulation();
  try {
    const audio = orbRunAudio(simulation);
    assert.deepEqual(await audio.play({ assetId: ORB_RUN_AUDIO_ASSET.win, bus: "nope" }), {
      success: false,
      error: 'Unknown audio bus "nope"',
    });
    assert.deepEqual(await audio.play({ assetId: "asset_missing", bus: ORB_RUN_AUDIO_BUS.sfx }), {
      success: false,
      error: 'Audio asset "asset_missing" not found',
    });
    assert.equal(audio.failures().length, 2);
    assert.equal(audio.cues().length, 0);

    const loop = await audio.play({ assetId: ORB_RUN_AUDIO_ASSET.win, bus: ORB_RUN_AUDIO_BUS.music, loop: true, entityId: ORB_RUN_ENTITY.manager });
    simulation.advance(60);
    assert.equal(audio.state().activePlaybacks.find((p) => p.playbackId === loop.playbackId)?.playing, true);
    assert.equal(audio.stop({ entityId: ORB_RUN_ENTITY.player }).stoppedCount, 0, "other entity untouched");
    assert.equal(audio.stop({ entityId: ORB_RUN_ENTITY.manager }).stoppedCount, 1);
    assert.equal(audio.state().activePlaybacks.find((p) => p.playbackId === loop.playbackId)?.playing, false);
  } finally {
    await simulation.dispose();
  }
});

test("instance gain is coerced like the Web Audio controller (NaN → 1, negative → 0)", async () => {
  const audio = new HeadlessAudioService({ now: () => 0, step: () => 0 });
  await audio.play({ assetId: ORB_RUN_AUDIO_ASSET.win, bus: ORB_RUN_AUDIO_BUS.sfx, gain: Number.NaN });
  await audio.play({ assetId: ORB_RUN_AUDIO_ASSET.win, bus: ORB_RUN_AUDIO_BUS.sfx, gain: -3 });
  assert.deepEqual(audio.cues().map((cue) => cue.gain), [1, 0]);
});

test("when the audio service refuses every play, the game still runs and each refusal is a warning log", async () => {
  const project = createOrbRunProject();
  const simulation = new HeadlessSceneSimulation({
    project,
    sceneId: ORB_RUN_SCENE_ID,
    scripts: createOrbRunScriptRegistry(project, ORB_RUN_SCENE_ID),
    createAudio: (clock) => new HeadlessAudioService({ ...clock, assetIds: [] }),
  });
  await simulation.start();
  try {
    playRoute(simulation);
    // Refusals arrive as promise results, i.e. after the synchronous steps.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(summarizeOrbRun(simulation).status, "won");
    for (const state of simulation.scriptStates()) {
      assert.notEqual(state.lifecycleState, "error", `${state.scriptId} survived refused audio`);
    }
    const warnings = simulation.logs("orbRun.audioFailed");
    assert.equal(warnings.length, 5, "3 pickups + chime + win");
    assert.ok(warnings.every((entry) => entry.level === "warning"));
    assert.match(String(warnings[0]?.data?.error), /not found/);
  } finally {
    await simulation.dispose();
  }
});

test("restoring a save replays no cues; later pickups continue the ladder from the saved count", async () => {
  const first = await startOrbRunSimulation();
  walkTo(first, ORB_RUN_WINNING_ROUTE[0]!);
  walkTo(first, ORB_RUN_WINNING_ROUTE[1]!);
  assert.equal(summarizeOrbRun(first).collectedCount, 2);
  const save = captureOrbRunSave(first);
  await first.dispose();

  const resumed = await startOrbRunSimulation();
  try {
    resumed.restoreStep(save.step);
    await restoreOrbRunSave(resumed, save);
    assert.deepEqual(orbRunAudio(resumed).cues(), [], "loading a save is silent");
    walkTo(resumed, ORB_RUN_WINNING_ROUTE[2]!);
    resumed.advance(1);
    assert.deepEqual(
      orbRunAudio(resumed).cues().map((cue) => cue.assetId),
      [ORB_RUN_PICKUP_ASSET_IDS[2], ORB_RUN_AUDIO_ASSET.exitUnlocked],
      "third orb → third note, then the chime",
    );
  } finally {
    await resumed.dispose();
  }
});

test("simulations without an audio factory run silently (scripts tolerate no context.audio)", async () => {
  const project = createOrbRunProject();
  const simulation = new HeadlessSceneSimulation({
    project,
    sceneId: ORB_RUN_SCENE_ID,
    scripts: createOrbRunScriptRegistry(project, ORB_RUN_SCENE_ID),
  });
  await simulation.start();
  try {
    assert.equal(simulation.audio, undefined);
    playRoute(simulation);
    assert.equal(summarizeOrbRun(simulation).status, "won");
    assert.deepEqual(simulation.logs("orbRun.audioFailed"), []);
    assert.throws(() => orbRunAudio(simulation), /not started with Orb Run audio/);
  } finally {
    await simulation.dispose();
  }
});

test("probe: audio snapshot, audio.played logs, and audio steps through the engine AcceptanceRunner", async () => {
  const manifest = acceptanceManifestSchema.parse({
    schemaVersion: 1,
    suite: "orb-run.audio-inline",
    steps: [
      { type: "runtime.start", sceneId: ORB_RUN_SCENE_ID },
      { type: "assert.equal", path: "state.audio.playedCount", expected: 0 },
      { type: "audio.setBusGain", busId: "sfx", gain: 0.5 },
      { type: "assert.near", path: "state.audio.buses.sfx.effectiveGain", expected: 0.5, tolerance: 1e-9 },
      { type: "audio.setBusMuted", busId: "master", muted: true },
      { type: "assert.equal", path: "state.audio.buses.sfx.effectiveGain", expected: 0 },
      { type: "audio.setBusMuted", busId: "master", muted: false },
      { type: "audio.play", assetId: ORB_RUN_AUDIO_ASSET.exitUnlocked, bus: "sfx", gain: 0.5 },
      { type: "assert.equal", path: "state.audio.played.asset_orbrun_sfx_exit_unlocked", expected: 1 },
      { type: "assert.equal", path: "state.audio.playbacks.0.playing", expected: true },
      { type: "wait", milliseconds: 500 },
      { type: "assert.equal", path: "state.audio.playbacks.0.playing", expected: false },
      { type: "runtime.stop" },
    ],
  });
  const report = await new AcceptanceRunner(new OrbRunHeadlessProbe()).run(manifest);
  const failed = report.steps.find((step) => !step.passed);
  assert.equal(report.passed, true, failed ? `step ${failed.index} (${failed.type}): ${failed.message ?? ""}` : "");

  const probe = new OrbRunHeadlessProbe();
  await probe.start(ORB_RUN_SCENE_ID, 0);
  await probe.playAudio({ assetId: ORB_RUN_AUDIO_ASSET.win, bus: "sfx" });
  const logs = await probe.logs();
  assert.ok(logs.some((log) => log.message === "audio.played" && log.data?.assetId === ORB_RUN_AUDIO_ASSET.win && log.data?.bus === "sfx"));
  await assert.rejects(probe.playAudio({ assetId: "asset_missing", bus: "sfx" }), /not found/);
  await assert.rejects(probe.playAudio({ assetId: ORB_RUN_AUDIO_ASSET.win, bus: "nope" }), /Unknown audio bus/);
  await assert.rejects(probe.setAudioBusGain("nope", 1), /Unknown audio bus/);
  await assert.rejects(probe.setAudioBusGain("sfx", Number.NaN), RangeError);
  await probe.stop();
});
