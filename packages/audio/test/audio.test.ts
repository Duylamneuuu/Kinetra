import assert from "node:assert/strict";
import test from "node:test";
import { AudioMixerModel, createSyntheticWav } from "../src/index.js";

test("audio bus gain and mute propagate through hierarchy", () => {
  const mixer = new AudioMixerModel([
    { id: "master", gain: 0.8 },
    { id: "music", parentId: "master", gain: 0.5 },
    { id: "sfx", parentId: "master", gain: 1 },
  ]);
  assert.equal(mixer.effectiveGain("music"), 0.4);
  mixer.setMuted("master", true);
  assert.equal(mixer.effectiveGain("music"), 0);
  assert.equal(mixer.effectiveGain("sfx"), 0);
});

test("audio bus errors name a missing parent and a cycle path", () => {
  assert.throws(
    () =>
      new AudioMixerModel([
        { id: "master", gain: 1 },
        { id: "music", parentId: "missing", gain: 1 },
      ]),
    /Audio bus parent "missing" is missing\. Available buses: master, music\./,
  );

  assert.throws(
    () =>
      new AudioMixerModel([
        { id: "music", parentId: "sfx", gain: 1 },
        { id: "sfx", parentId: "music", gain: 1 },
      ]),
    /Audio bus cycle detected: music -> sfx -> music\./,
  );

  const ids = Array.from({ length: 13 }, (_, index) => `bus-${String(index).padStart(2, "0")}`);
  assert.throws(
    () =>
      new AudioMixerModel(
        ids.map((id, index) => ({
          id,
          parentId: ids[(index + 1) % ids.length],
          gain: 1,
        })),
      ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(
        error.message,
        `Audio bus cycle detected: ${ids.slice(0, 12).join(" -> ")}, and 1 more, returning to ${ids[0]}.`,
      );
      assert.equal(error.message.includes("bus-12"), false);
      return true;
    },
  );

  assert.throws(
    () =>
      new AudioMixerModel([
        ...ids.map((id) => ({ id, gain: 1 })),
        { id: "voice", parentId: "missing", gain: 1 },
      ]),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(
        error.message,
        /Audio bus parent "missing" is missing\. Available buses: bus-00, bus-01, bus-02, bus-03, bus-04, bus-05, bus-06, bus-07, bus-08, bus-09, bus-10, bus-11, and 2 more\./,
      );
      assert.equal(error.message.includes("bus-12"), false);
      assert.equal(error.message.includes("voice"), false);
      return true;
    },
  );
});

test("audio mixer query methods inspect bus states correctly", () => {
  const mixer = new AudioMixerModel([
    { id: "master", gain: 0.8 },
    { id: "sfx", parentId: "master", gain: 0.5 },
  ]);

  assert.equal(mixer.hasBus("master"), true);
  assert.equal(mixer.hasBus("sfx"), true);
  assert.equal(mixer.hasBus("voice"), false);

  const masterBus = mixer.getBus("master");
  assert.deepEqual(masterBus, { id: "master", gain: 0.8 });

  const sfxState = mixer.getBusState("sfx");
  assert.deepEqual(sfxState, {
    id: "sfx",
    parentId: "master",
    gain: 0.5,
    effectiveGain: 0.4,
    muted: false,
  });

  const allStates = mixer.getAllBusStates();
  assert.equal(allStates.length, 2);
  assert.deepEqual(allStates.map((s) => s.id).sort(), ["master", "sfx"]);
});

test("createSyntheticWav produces valid RIFF WAVE buffer", () => {
  const wav = createSyntheticWav({ sampleRate: 44100, durationSeconds: 0.1, frequency: 440 });
  assert.ok(wav.byteLength > 44);

  // Check magic bytes
  const textDecoder = new TextDecoder();
  assert.equal(textDecoder.decode(wav.subarray(0, 4)), "RIFF");
  assert.equal(textDecoder.decode(wav.subarray(8, 12)), "WAVE");
  assert.equal(textDecoder.decode(wav.subarray(12, 16)), "fmt ");
  assert.equal(textDecoder.decode(wav.subarray(36, 40)), "data");

  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const sampleRate = view.getUint32(24, true);
  assert.equal(sampleRate, 44100);
  const channels = view.getUint16(22, true);
  assert.equal(channels, 1);
  const bitsPerSample = view.getUint16(34, true);
  assert.equal(bitsPerSample, 16);

  // Verify non-zero PCM samples exist
  let nonZero = 0;
  for (let offset = 44; offset < wav.byteLength; offset += 2) {
    if (view.getInt16(offset, true) !== 0) {
      nonZero++;
    }
  }
  assert.ok(nonZero > 0);
});

