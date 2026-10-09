import assert from "node:assert/strict";
import test from "node:test";
import { AudioMixerModel, createSyntheticWav, MAX_SYNTHETIC_WAV_DATA_BYTES } from "../src/index.js";

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

test("setMuted and the constructor reject non-boolean muted values instead of silencing a bus by truthiness", () => {
  const mixer = new AudioMixerModel([{ id: "master", gain: 1 }]);
  for (const value of ["false", 0, 1, null, undefined] as unknown[]) {
    assert.throws(() => mixer.setMuted("master", value as boolean), TypeError, String(value));
  }
  assert.equal(mixer.effectiveGain("master"), 1);
  assert.throws(() => new AudioMixerModel([{ id: "m", gain: 1, muted: "no" as unknown as boolean }]), TypeError);
  mixer.setMuted("master", true);
  assert.equal(mixer.effectiveGain("master"), 0);
  assert.equal(mixer.getBusState("master")?.muted, true);
  assert.throws(() => mixer.setMuted("missing", true), /Unknown audio bus/);
});

test("createSyntheticWav caps the payload size with a structured RangeError and keeps the cap itself buildable", () => {
  assert.throws(() => createSyntheticWav({ durationSeconds: 1e9 }), /createSyntheticWav.*limit/);
  assert.throws(() => createSyntheticWav({ sampleRate: 2_000_000_000, durationSeconds: 10 }), RangeError);
  // 1 second at the maximum sample rate the header supports would be ~4 GB, far over the cap.
  assert.throws(() => createSyntheticWav({ sampleRate: 2_147_483_647, durationSeconds: 1 }), /limit/);
  const exactly = createSyntheticWav({ sampleRate: 1000, durationSeconds: 2 });
  assert.equal(exactly.byteLength, 44 + 4000);
  const view = new DataView(exactly.buffer, exactly.byteOffset, exactly.byteLength);
  assert.equal(view.getUint32(4, true), 36 + 4000);
  assert.equal(view.getUint32(40, true), 4000);
  assert.equal(MAX_SYNTHETIC_WAV_DATA_BYTES, 64 * 1024 * 1024);
});

test("createSyntheticWav output is deterministic and every sample stays inside the 0.8 amplitude envelope", () => {
  const a = createSyntheticWav({ sampleRate: 8000, durationSeconds: 0.1, frequency: 123 });
  const b = createSyntheticWav({ sampleRate: 8000, durationSeconds: 0.1, frequency: 123 });
  assert.deepEqual(a, b);
  const view = new DataView(a.buffer, a.byteOffset, a.byteLength);
  const limit = Math.ceil(0.8 * 32767);
  for (let offset = 44; offset < a.byteLength; offset += 2) assert.ok(Math.abs(view.getInt16(offset, true)) <= limit);
  // frequency 0 is silence
  const silent = createSyntheticWav({ sampleRate: 8000, durationSeconds: 0.01, frequency: 0 });
  assert.ok(new Uint8Array(silent.buffer, silent.byteOffset + 44).every((byte) => byte === 0));
});
