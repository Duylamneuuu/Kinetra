import assert from "node:assert/strict";
import test from "node:test";

import {
  AcceptanceRunner,
  type AcceptanceManifest,
  type RuntimeInput,
  type RuntimeProbe,
  type RuntimeSnapshot,
} from "../src/index.js";

/** A probe with only the required RuntimeProbe methods (issue #122). */
class MinimalProbe implements RuntimeProbe {
  state: RuntimeSnapshot = { running: false, state: {} };
  waited = 0;
  async start(sceneId: string, _seed: number) {
    this.state = { running: true, sceneId, state: {} };
  }
  async stop() {
    this.state = { running: false, state: {} };
  }
  async input(_event: RuntimeInput) {}
  async wait(milliseconds: number) {
    this.waited += milliseconds;
  }
  async snapshot() {
    return structuredClone(this.state);
  }
  async logs() {
    return [];
  }
  async captureFrame() {
    return new Uint8Array();
  }
  async metrics() {
    return {};
  }
}

type Step = AcceptanceManifest["steps"][number];

const OPTIONAL_STEPS: Array<{ step: unknown; method: string }> = [
  { step: { type: "asset.register", assetId: "a", dataBase64: "AA==" }, method: "registerAsset" },
  { step: { type: "runtime.pause" }, method: "pause" },
  { step: { type: "runtime.resume" }, method: "resume" },
  { step: { type: "animation.play", entityId: "e", clip: "walk" }, method: "playAnimation" },
  { step: { type: "animation.stop", entityId: "e" }, method: "stopAnimation" },
  { step: { type: "audio.play", assetId: "a" }, method: "playAudio" },
  { step: { type: "audio.stop" }, method: "stopAudio" },
  { step: { type: "audio.setBusGain", busId: "sfx", gain: 0.5 }, method: "setAudioBusGain" },
  { step: { type: "audio.setBusMuted", busId: "sfx", muted: true }, method: "setAudioBusMuted" },
  { step: { type: "navigation.bake" }, method: "bakeNavigation" },
  { step: { type: "navigation.load", dataBase64: "AA==" }, method: "loadNavigation" },
  { step: { type: "navigation.closestPoint", position: [0, 0, 0] }, method: "closestPointNavigation" },
  {
    step: { type: "navigation.computePath", start: [0, 0, 0], end: [1, 0, 1] },
    method: "computePathNavigation",
  },
  { step: { type: "save.capture" }, method: "captureSave" },
  { step: { type: "save.load" }, method: "loadSave" },
];

function manifest(steps: unknown[]): AcceptanceManifest {
  return {
    schemaVersion: 1,
    suite: "unsupported-step",
    seed: 0,
    target: "runtime",
    steps: steps as Step[],
  } as AcceptanceManifest;
}

for (const { step, method } of OPTIONAL_STEPS) {
  const type = (step as { type: string }).type;
  test(`${type} fails with UNSUPPORTED_STEP when the probe lacks ${method}()`, async () => {
    const report = await new AcceptanceRunner(new MinimalProbe()).run(
      manifest([{ type: "runtime.start", sceneId: "main" }, step, { type: "runtime.stop" }]),
    );
    assert.equal(report.passed, false, `${type} must not pass on a probe without ${method}()`);
    const failed = report.steps.find((s) => !s.passed);
    assert.equal(failed?.type, type);
    assert.match(failed?.message ?? "", /UNSUPPORTED_STEP/);
    assert.match(failed?.message ?? "", new RegExp(method));
  });
}

test("runtime.start with assets fails when the probe cannot register them", async () => {
  const report = await new AcceptanceRunner(new MinimalProbe()).run(
    manifest([{ type: "runtime.start", sceneId: "main", assets: { crate: "AA==" } }]),
  );
  assert.equal(report.passed, false);
  assert.match(report.steps[0]?.message ?? "", /UNSUPPORTED_STEP.*registerAsset/);
});

test("runtime.start without assets and runtime.step still work on a minimal probe", async () => {
  const probe = new MinimalProbe();
  const report = await new AcceptanceRunner(probe).run(
    manifest([
      { type: "runtime.start", sceneId: "main", assets: {} },
      { type: "runtime.step", steps: 6, deltaSeconds: 0.5 },
      { type: "runtime.stop" },
    ]),
  );
  assert.equal(report.passed, true, JSON.stringify(report.steps));
  assert.equal(probe.waited, 3000);
});
