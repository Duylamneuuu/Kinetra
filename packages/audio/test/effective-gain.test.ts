import assert from "node:assert/strict";
import test from "node:test";

import { AudioMixerModel } from "../src/index.js";

test("effectiveGain stays finite when ancestor gains overflow the product", () => {
  const mixer = new AudioMixerModel([
    { id: "master", gain: 1e200 },
    { id: "sfx", parentId: "master", gain: 1e200 },
  ]);
  const gain = mixer.effectiveGain("sfx");
  // Infinity would make a Web Audio GainNode throw when the player applies it.
  assert.ok(Number.isFinite(gain), `expected a finite effective gain, got ${String(gain)}`);
  assert.ok(gain > 0);
  assert.equal(mixer.getBusState("sfx")?.effectiveGain, gain);
});

test("a zero-gain bus silences the subtree even when other factors overflow (no NaN)", () => {
  const mixer = new AudioMixerModel([
    { id: "master", gain: 1e200 },
    { id: "sfx", parentId: "master", gain: 1e200 },
    { id: "voice", parentId: "sfx", gain: 0 },
  ]);
  // 1e200 * 1e200 * 0 evaluates to Infinity * 0 = NaN when multiplied in order.
  assert.equal(mixer.effectiveGain("voice"), 0);
});

test("ordinary gains still multiply down the chain", () => {
  const mixer = new AudioMixerModel([
    { id: "master", gain: 0.5 },
    { id: "sfx", parentId: "master", gain: 0.5 },
  ]);
  assert.equal(mixer.effectiveGain("sfx"), 0.25);
});
