import assert from "node:assert/strict";
import test from "node:test";

import { AudioMixerModel, MAX_AUDIO_GAIN } from "../src/index.js";

test("the gain ceiling is documented as a linear factor of 4", () => {
  assert.equal(MAX_AUDIO_GAIN, 4);
});

test("effectiveGain is clamped to the ceiling when boosted ancestors multiply past it", () => {
  const mixer = new AudioMixerModel([
    { id: "master", gain: 4 },
    { id: "sfx", parentId: "master", gain: 4 },
    { id: "voice", parentId: "sfx", gain: 4 },
  ]);
  // 4 * 4 * 4 = 64 would be an absurd volume; Web Audio GainNode also rejects non-finite values.
  assert.equal(mixer.effectiveGain("voice"), MAX_AUDIO_GAIN);
  assert.equal(mixer.getBusState("voice")?.effectiveGain, MAX_AUDIO_GAIN);
  assert.equal(mixer.effectiveGain("master"), 4);
});

test("effectiveGain stays within 0..MAX_AUDIO_GAIN even for a very deep chain of boosted buses", () => {
  const depth = 2000; // 4 ** 2000 overflows to Infinity
  const buses = [{ id: "b0", gain: 4 }];
  for (let i = 1; i < depth; i++) buses.push({ id: `b${i}`, gain: 4, parentId: `b${i - 1}` } as never);
  const mixer = new AudioMixerModel(buses);
  const gain = mixer.effectiveGain(`b${depth - 1}`);
  assert.ok(Number.isFinite(gain));
  assert.equal(gain, MAX_AUDIO_GAIN);
});

test("a gain above the ceiling, or not a finite number, is rejected with a RangeError on construction and setGain", () => {
  for (const bad of [4.0001, 5, 1e200, 1e308, Number.MAX_VALUE, Infinity, -Infinity, NaN, -0.1]) {
    assert.throws(() => new AudioMixerModel([{ id: "master", gain: bad }]), RangeError, `ctor ${String(bad)}`);
    const mixer = new AudioMixerModel([{ id: "master", gain: 1 }]);
    assert.throws(() => mixer.setGain("master", bad), /within 0\.\.4/, `setGain ${String(bad)}`);
    assert.equal(mixer.getBus("master")?.gain, 1, `a rejected gain leaves the bus untouched (${String(bad)})`);
    assert.equal(mixer.effectiveGain("master"), 1);
  }
});

test("the ceiling itself and zero are accepted", () => {
  const mixer = new AudioMixerModel([{ id: "master", gain: MAX_AUDIO_GAIN }]);
  mixer.setGain("master", 0);
  assert.equal(mixer.effectiveGain("master"), 0);
  mixer.setGain("master", MAX_AUDIO_GAIN);
  assert.equal(mixer.effectiveGain("master"), MAX_AUDIO_GAIN);
});

test("a zero-gain bus silences the subtree even when other factors are boosted (no NaN)", () => {
  const mixer = new AudioMixerModel([
    { id: "master", gain: 4 },
    { id: "sfx", parentId: "master", gain: 4 },
    { id: "voice", parentId: "sfx", gain: 0 },
  ]);
  assert.equal(mixer.effectiveGain("voice"), 0);
});

test("ordinary gains still multiply down the chain", () => {
  const mixer = new AudioMixerModel([
    { id: "master", gain: 0.5 },
    { id: "sfx", parentId: "master", gain: 0.5 },
  ]);
  assert.equal(mixer.effectiveGain("sfx"), 0.25);
});
