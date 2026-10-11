import assert from "node:assert/strict";
import test from "node:test";

import type { BlendSpace1DDefinition } from "@kinetra/animation/blend-space.js";
import * as THREE from "three";

import { BlendSpacePlayback } from "../src/index.js";

const definition: BlendSpace1DDefinition = {
  schemaVersion: 1,
  kind: "1d",
  id: "overflow_space",
  parameter: "speed",
  samples: [
    { clipId: "walk", position: 0 },
    { clipId: "run", position: 1 },
  ],
};

function clip(name: string, duration: number): THREE.AnimationClip {
  return new THREE.AnimationClip(name, duration, [
    new THREE.NumberKeyframeTrack(".position[x]", [0, duration], [0, 1]),
  ]);
}

function start(speed: number): { playback: BlendSpacePlayback; mixer: THREE.AnimationMixer } {
  const mixer = new THREE.AnimationMixer(new THREE.Object3D());
  const created = BlendSpacePlayback.create(definition, mixer, [clip("walk", 1), clip("run", 0.5)], { speed });
  assert.ok(created.success, "blend space must start");
  created.playback.begin();
  return { playback: created.playback, mixer };
}

test("a finite speed whose phase advance overflows to Infinity does not poison the phase with NaN", () => {
  const { playback } = start(1e308);
  // 1e308 * 10 overflows to Infinity; the phase used to become NaN and stay NaN.
  playback.prepareStep(10);
  assert.ok(Number.isFinite(playback.state().phase), `phase must stay finite, got ${playback.state().phase}`);
  assert.ok(playback.state().phase >= 0 && playback.state().phase < 1);
});

test("the blend space recovers after an overflowing step once the speed is sane again", () => {
  const { playback, mixer } = start(1e308);
  playback.prepareStep(10);
  mixer.update(0);
  assert.equal(playback.setSpeed(1), true);
  playback.prepareStep(0.25);
  mixer.update(0.25);
  const phase = playback.state().phase;
  assert.ok(Number.isFinite(phase), `phase must recover, got ${phase}`);
  for (const name of playback.clipNames) {
    const time = playback.getAction(name)?.time;
    assert.ok(typeof time === "number" && Number.isFinite(time), `action ${name} time must be finite, got ${time}`);
  }
});

test("a negative overflowing speed also keeps the phase finite", () => {
  const { playback } = start(-1e308);
  playback.prepareStep(10);
  assert.ok(Number.isFinite(playback.state().phase), `phase must stay finite, got ${playback.state().phase}`);
});
