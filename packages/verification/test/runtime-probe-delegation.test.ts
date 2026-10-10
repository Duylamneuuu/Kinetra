import assert from "node:assert/strict";
import test from "node:test";

import { KinetraRuntimeProbe, type RuntimeProbeHost } from "../src/index.js";

type Calls = Array<[string, ...unknown[]]>;

/** A host that implements every optional capability and records each call it receives. */
function fullHost(overrides: Record<string, unknown> = {}): {
  host: RuntimeProbeHost;
  calls: Calls;
} {
  const calls: Calls = [];
  const record =
    (name: string, result?: unknown) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args]);
      return result;
    };
  const host = {
    start: record("start"),
    stop: record("stop"),
    close: record("close"),
    query: async () => ({ running: true, entities: [] }),
    readLogs: async () => [],
    injectInput: record("injectInput"),
    captureFrame: async () => ({ available: true, base64: "AQID" }),
    enableTestScriptFixtures: record("enableTestScriptFixtures"),
    registerAsset: record("registerAsset"),
    updateAsset: record("updateAsset"),
    reloadAsset: record("reloadAsset", {
      success: true,
      affectedEntities: ["e1"],
    }),
    step: record("step"),
    bakeNavigation: record("bakeNavigation"),
    loadNavigation: record("loadNavigation"),
    closestPointNavigation: record("closestPointNavigation"),
    computePathNavigation: record("computePathNavigation"),
    playAnimation: record("playAnimation"),
    registerAnimationClip: record("registerAnimationClip"),
    stopAnimation: record("stopAnimation"),
    playAudio: record("playAudio"),
    stopAudio: record("stopAudio"),
    setAudioBusGain: record("setAudioBusGain"),
    setAudioBusMuted: record("setAudioBusMuted"),
    captureSave: record("captureSave", { success: true, envelope: { s: 1 } }),
    getSave: record("getSave", { success: true, envelope: { s: 2 } }),
    loadSave: record("loadSave", { success: true, slotId: "x", schemaVersion: 4 }),
    pause: record("pause"),
    resume: record("resume"),
    detachModel: record("detachModel", { detached: true }),
    attachModel: record("attachModel", { attached: true }),
    samplePerformance: record("samplePerformance", { sampled: true }),
    ...overrides,
  };
  return { host: host as unknown as RuntimeProbeHost, calls };
}

const project = { id: "p" } as never;

test("probe forwards every optional host capability with its arguments unchanged", async () => {
  const { host, calls } = fullHost();
  const probe = new KinetraRuntimeProbe({ host, project });

  await probe.registerAsset("a", "AAA", { fingerprint: "f", sourceHash: "h" });
  await probe.updateAsset("a", "BBB");
  assert.deepEqual(await probe.reloadAsset("a"), {
    success: true,
    affectedEntities: ["e1"],
  });
  await probe.step(4, 0.5);
  await probe.bakeNavigation({ positions: [0, 1, 2], indices: [0, 0, 0], config: { cs: 1 } });
  await probe.loadNavigation({ dataBase64: "ZGF0YQ==" });
  await probe.closestPointNavigation({ position: [1, 2, 3], halfExtents: [1, 1, 1] });
  await probe.computePathNavigation({ start: [0, 0, 0], end: [1, 0, 1] });
  await probe.playAnimation("e1", "run", { loop: true, retargetSource: "rig" });
  await probe.registerAnimationClip("e1", { name: "run" });
  await probe.stopAnimation("e1");
  await probe.playAudio({ assetId: "sfx", bus: "sfx", loop: false, gain: 0.5, entityId: "e1" });
  await probe.stopAudio({ playbackId: "p1" });
  await probe.setAudioBusGain("music", 0.25);
  await probe.setAudioBusMuted("music", true);
  await probe.pause();
  await probe.resume();

  assert.deepEqual(calls, [
    ["registerAsset", "a", "AAA", { fingerprint: "f", sourceHash: "h" }],
    ["updateAsset", "a", "BBB", undefined],
    ["reloadAsset", "a"],
    ["step", 4, 0.5],
    ["bakeNavigation", { positions: [0, 1, 2], indices: [0, 0, 0], config: { cs: 1 } }],
    ["loadNavigation", { dataBase64: "ZGF0YQ==" }],
    ["closestPointNavigation", { position: [1, 2, 3], halfExtents: [1, 1, 1] }],
    ["computePathNavigation", { start: [0, 0, 0], end: [1, 0, 1] }],
    ["playAnimation", "e1", "run", { loop: true, retargetSource: "rig" }],
    ["registerAnimationClip", "e1", { name: "run" }],
    ["stopAnimation", "e1"],
    ["playAudio", { assetId: "sfx", bus: "sfx", loop: false, gain: 0.5, entityId: "e1" }],
    ["stopAudio", { playbackId: "p1" }],
    ["setAudioBusGain", "music", 0.25],
    ["setAudioBusMuted", "music", true],
    ["pause"],
    ["resume"],
  ]);
});

test("probe returns the host's save, model and performance results untouched", async () => {
  const { host, calls } = fullHost();
  const probe = new KinetraRuntimeProbe({ host, project });

  assert.deepEqual(await probe.captureSave("slot-1"), { success: true, envelope: { s: 1 } });
  assert.deepEqual(await probe.getSave("slot-1"), { success: true, envelope: { s: 2 } });
  assert.deepEqual(await probe.loadSave({ slotId: "x" }), {
    success: true,
    slotId: "x",
    schemaVersion: 4,
  });
  assert.deepEqual(await probe.detachModel("e1"), { detached: true });
  assert.deepEqual(await probe.attachModel("e1", "asset"), { attached: true });
  assert.deepEqual(await probe.samplePerformance({ sampleFrames: 3, mode: "stepped" }), {
    sampled: true,
  });
  assert.deepEqual(calls, [
    ["captureSave", "slot-1"],
    ["getSave", "slot-1"],
    ["loadSave", { slotId: "x" }],
    ["detachModel", "e1"],
    ["attachModel", "e1", "asset"],
    ["samplePerformance", { sampleFrames: 3, mode: "stepped" }],
  ]);
});

test("probe start enables the test script preset before starting and passes asset metadata", async () => {
  const { host, calls } = fullHost();
  const probe = new KinetraRuntimeProbe({
    host,
    project,
    testScriptPreset: "combat",
    assets: async () => ({ a: "AAA" }),
    assetMetadata: async () => ({ a: { fingerprint: "f" } }),
    initialRevision: 2,
  });
  await probe.start("scene-1", 99);
  assert.deepEqual(calls, [
    ["enableTestScriptFixtures", "combat"],
    ["start", project, "scene-1", 2, { a: "AAA" }, { assetMetadata: { a: { fingerprint: "f" } } }],
  ]);
});

test("probe start skips the script preset hook when the host lacks it", async () => {
  const { host, calls } = fullHost({ enableTestScriptFixtures: undefined });
  await new KinetraRuntimeProbe({ host, project, testScriptPreset: "combat" }).start("s", 0);
  assert.deepEqual(
    calls.map((c) => c[0]),
    ["start"],
  );
  // Without metadata the options bag is empty rather than carrying an undefined key.
  assert.deepEqual(calls[0]?.[5], {});
});

test("probe captureFrame decodes base64 and reports a generic reason when none is given", async () => {
  const ok = new KinetraRuntimeProbe({ host: fullHost().host, project });
  assert.deepEqual([...(await ok.captureFrame())], [1, 2, 3]);

  const noReason = new KinetraRuntimeProbe({
    host: fullHost({ captureFrame: async () => ({ available: false }) }).host,
    project,
  });
  await assert.rejects(() => noReason.captureFrame(), /Runtime frame capture is unavailable/);

  // "available" without any bytes is still a failure, not an empty frame.
  const empty = new KinetraRuntimeProbe({
    host: fullHost({ captureFrame: async () => ({ available: true, base64: "" }) }).host,
    project,
  });
  await assert.rejects(() => empty.captureFrame(), /Runtime frame capture is unavailable/);
});

test("probe stop and close sequencing with and without host.close", async () => {
  const withClose = fullHost();
  const a = new KinetraRuntimeProbe({ host: withClose.host, project });
  await a.stop();
  assert.deepEqual(withClose.calls, [["stop"]], "stop alone does not close the host by default");
  await a.close();
  assert.deepEqual(
    withClose.calls.map((c) => c[0]),
    ["stop", "stop", "close"],
  );

  const noClose = fullHost({ close: undefined });
  const b = new KinetraRuntimeProbe({ host: noClose.host, project, closeOnStop: true });
  await b.stop();
  await b.close();
  assert.deepEqual(
    noClose.calls.map((c) => c[0]),
    ["stop", "stop"],
  );
});

test("probe snapshot carries optional navigation/audio/gameplay/game/shell/renderer state only when present", async () => {
  const bare = new KinetraRuntimeProbe({
    host: fullHost({ query: async () => ({ running: false, entities: [] }) }).host,
    project,
  });
  const bareSnap = await bare.snapshot();
  assert.equal(bareSnap.running, false);
  assert.deepEqual(Object.keys(bareSnap.state as object).sort(), ["byEntityId", "byName", "entities"]);
  assert.equal("shell" in bareSnap, false);
  assert.equal("renderer" in bareSnap, false);

  const rich = new KinetraRuntimeProbe({
    host: fullHost({
      query: async () => ({
        running: true,
        sceneId: "host-scene",
        entities: [],
        navigation: { n: 1 },
        audio: { a: 1 },
        gameplay: { g: 1 },
        game: { game: 1 },
        shell: { s: 1 },
        renderer: { r: 1 },
      }),
    }).host,
    project,
  });
  await rich.start("probe-scene", 0);
  const snap = await rich.snapshot();
  assert.equal(snap.sceneId, "host-scene", "host-reported scene wins over the probe's remembered one");
  assert.deepEqual(snap.shell, { s: 1 });
  assert.deepEqual(snap.renderer, { r: 1 });
  const state = snap.state as Record<string, unknown>;
  assert.deepEqual(state["navigation"], { n: 1 });
  assert.deepEqual(state["audio"], { a: 1 });
  assert.deepEqual(state["gameplay"], { g: 1 });
  assert.deepEqual(state["game"], { game: 1 });
  assert.deepEqual(state["shell"], { s: 1 });
  assert.deepEqual(state["renderer"], { r: 1 });
});

test("probe input omits value/durationMs unless supplied and keeps zero values", async () => {
  const { host, calls } = fullHost();
  const probe = new KinetraRuntimeProbe({ host, project });
  await probe.input({ action: "move", phase: "held" } as never);
  await probe.input({ action: "move", phase: "held", value: 0, durationMs: 0 } as never);
  assert.deepEqual(calls, [
    ["injectInput", { action: "move", phase: "held" }],
    ["injectInput", { action: "move", phase: "held", value: 0, durationMs: 0 }],
  ]);
});
