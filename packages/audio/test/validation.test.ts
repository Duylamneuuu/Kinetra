import assert from "node:assert/strict";
import test from "node:test";
import { AudioMixerModel, createSyntheticWav } from "../src/index.js";

test("constructor rejects bus gains that setGain would reject (no NaN effective gain)", () => {
  for (const gain of [Number.NaN, -0.5, Number.POSITIVE_INFINITY, "1" as unknown as number]) {
    assert.throws(
      () => new AudioMixerModel([{ id: "master", gain }]),
      RangeError,
      `expected gain ${String(gain)} to be rejected`,
    );
  }
});

test("constructor rejects empty or non-string bus ids and self-parenting", () => {
  assert.throws(() => new AudioMixerModel([{ id: "", gain: 1 }]), /bus id/);
  assert.throws(() => new AudioMixerModel([{ id: 3 as unknown as string, gain: 1 }]), /bus id/);
  assert.throws(() => new AudioMixerModel([{ id: "a", parentId: "a", gain: 1 }]), /cycle/);
});

test("constructor does not alias caller definitions and keeps declaration order", () => {
  const defs = [
    { id: "master", gain: 1 },
    { id: "sfx", parentId: "master", gain: 0.5 },
  ];
  const mixer = new AudioMixerModel(defs);
  defs[1]!.gain = 99;
  assert.equal(mixer.effectiveGain("sfx"), 0.5);
  assert.deepEqual(mixer.getAllBusStates().map((state) => state.id), ["master", "sfx"]);
});

test("createSyntheticWav rejects invalid options instead of throwing opaque buffer errors or writing inconsistent headers", () => {
  for (const options of [
    { sampleRate: 0 },
    { sampleRate: -44100 },
    { sampleRate: 22050.5 },
    { durationSeconds: -1 },
    { durationSeconds: Number.NaN },
    { durationSeconds: Number.POSITIVE_INFINITY },
    { frequency: Number.NaN },
    { frequency: -440 },
  ]) {
    assert.throws(() => createSyntheticWav(options), /createSyntheticWav/, JSON.stringify(options));
  }
});

test("createSyntheticWav with zero duration yields a valid empty data chunk", () => {
  const wav = createSyntheticWav({ durationSeconds: 0 });
  assert.equal(wav.byteLength, 44);
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  assert.equal(view.getUint32(40, true), 0);
  assert.equal(view.getUint32(4, true), 36);
});
