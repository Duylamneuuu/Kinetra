# @kinetra/audio

Platform-free audio model: a bus tree with gain and mute, the state shapes the runtime reports, and a deterministic WAV generator for tests and fixtures. It never touches Web Audio or a file; the player's audio runtime (`apps/player`) owns the actual playback and reports back with the state types defined here.

## Entry points

| Export | Kind | What it does |
| --- | --- | --- |
| `AudioMixerModel` | class | Bus tree built from `AudioBusDefinition[]`. `hasBus`, `getBus`, `getBuses`, `getBusState`, `getAllBusStates`, `setGain(id, gain)`, `setMuted(id, muted)`, `effectiveGain(id)`. |
| `AudioBusDefinition` | type | `{ id, parentId?, gain, muted? }`. |
| `AudioBusState` | type | Bus plus its computed `effectiveGain`. |
| `AudioPlaybackState`, `AudioRuntimeState` | types | What the player runtime reports: initialised flag, bus states and active playbacks (`playbackId`, `assetId`, `bus`, `loop`, `gain`, `effectiveGain`, `muted`, optional `duration`, `currentTime`, `error`). |
| `createSyntheticWav({ sampleRate?, durationSeconds?, frequency? })` | function | 16-bit mono PCM sine wave as `Uint8Array` (defaults 44100 Hz, 0.25 s, 440 Hz). Same options give byte-identical output. |

## Behaviour worth knowing

- `effectiveGain(id)` multiplies the gain up the parent chain. A muted bus anywhere on the chain makes it `0`. The result is always finite and within `0..MAX_AUDIO_GAIN`: a chain of boosted buses whose product exceeds the ceiling is clamped to it.
- Gain ceiling: `MAX_AUDIO_GAIN` is `4` (+12 dB, a linear factor). A bus gain above it (or negative, `NaN`, `Infinity`) is **rejected**, not clamped: the constructor and `setGain` throw a `RangeError` naming the bus and the `0..4` range, and the bus keeps its previous gain.
- The constructor throws on an empty or duplicate bus id, a missing parent, a cycle, or a gain outside `0..MAX_AUDIO_GAIN`. `setGain` applies the same gain rule with a `RangeError`; an unknown bus id throws.
- `getBus` / `getBuses` return clones; mutate buses only through `setGain` and `setMuted`.
- `createSyntheticWav` throws `RangeError` for a non-integer or non-positive `sampleRate`, or a negative or non-finite `durationSeconds` / `frequency`, or when the PCM payload would exceed `MAX_SYNTHETIC_WAV_DATA_BYTES` (64 MiB). `setMuted` and the constructor throw `TypeError` for a non-boolean `muted`.

## Example

```ts doc-check
import assert from "node:assert/strict";
import { AudioMixerModel, createSyntheticWav } from "@kinetra/audio";

const mixer = new AudioMixerModel([
  { id: "master", gain: 0.5 },
  { id: "sfx", parentId: "master", gain: 0.8 },
  { id: "music", parentId: "master", gain: 1 },
]);
assert.ok(Math.abs(mixer.effectiveGain("sfx") - 0.4) < 1e-9);

mixer.setMuted("master", true);
assert.equal(mixer.effectiveGain("sfx"), 0);
mixer.setMuted("master", false);

assert.throws(() => mixer.setGain("sfx", -1), RangeError);
assert.throws(() => mixer.setGain("sfx", 1e308), RangeError); // above MAX_AUDIO_GAIN (4)
assert.throws(() => mixer.effectiveGain("missing"), /Unknown audio bus/);
assert.throws(
  () => new AudioMixerModel([{ id: "a", parentId: "b", gain: 1 }, { id: "b", parentId: "a", gain: 1 }]),
  /cycle/,
);

// Deterministic fixture audio: 44-byte RIFF/WAVE header + 16-bit samples.
const wav = createSyntheticWav({ sampleRate: 8000, durationSeconds: 0.5, frequency: 220 });
assert.equal(wav.byteLength, 44 + 8000 * 0.5 * 2);
assert.equal(String.fromCharCode(...wav.slice(0, 4)), "RIFF");
assert.deepEqual(wav, createSyntheticWav({ sampleRate: 8000, durationSeconds: 0.5, frequency: 220 }));
```

## Proof level

Unit tests live in `packages/audio/test` and run through the package `test` script. Real playback in the Electron player is covered where [`docs/STATUS.md`](../../docs/STATUS.md) lists it; this package alone proves the bus maths and the WAV encoder, not audible output.
