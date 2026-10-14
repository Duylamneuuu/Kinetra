import assert from "node:assert/strict";
import test from "node:test";

import { HeadlessAudioService, ORB_RUN_AUDIO_ASSET_IDS, ORB_RUN_AUDIO_BUS } from "../src/index.js";

const FIXED_DELTA = 1 / 30;

function createService(): { audio: HeadlessAudioService; setStep: (step: number) => void } {
  let step = 0;
  const audio = new HeadlessAudioService({ now: () => step * FIXED_DELTA, step: () => step });
  return {
    audio,
    setStep: (next) => {
      step = next;
    },
  };
}

const assetId = ORB_RUN_AUDIO_ASSET_IDS[0]!;

function playingFlags(audio: HeadlessAudioService): Record<string, boolean> {
  return Object.fromEntries(audio.state().activePlaybacks.map((playback) => [playback.playbackId, playback.playing]));
}

test("rewindTo undoes a stop that happened after the cut-off step", async () => {
  const { audio, setStep } = createService();
  setStep(2);
  const music = await audio.play({ assetId, bus: ORB_RUN_AUDIO_BUS.master, loop: true });
  assert.equal(music.success, true);
  setStep(10);
  assert.equal(audio.stop({ playbackId: music.playbackId! }).stoppedCount, 1);
  assert.equal(playingFlags(audio)[music.playbackId!], false);

  // Quick-load back to step 5: the stop at step 10 belongs to the abandoned timeline.
  setStep(5);
  assert.equal(audio.rewindTo(5), 0, "the loop started at step 2 is kept");
  assert.equal(playingFlags(audio)[music.playbackId!], true, "the loop was still playing at step 5");

  // The restored timeline can stop it again.
  setStep(6);
  assert.equal(audio.stop({ playbackId: music.playbackId! }).stoppedCount, 1);
  assert.equal(playingFlags(audio)[music.playbackId!], false);
});

test("rewindTo keeps a stop that happened at or before the cut-off step", async () => {
  const { audio, setStep } = createService();
  setStep(2);
  const music = await audio.play({ assetId, loop: true });
  setStep(4);
  audio.stop({ playbackId: music.playbackId! });
  setStep(9);
  audio.rewindTo(6);
  setStep(6);
  assert.equal(playingFlags(audio)[music.playbackId!], false, "stopped at step 4, which the save at step 6 includes");
  setStep(4);
  audio.rewindTo(4);
  assert.equal(playingFlags(audio)[music.playbackId!], false, "a stop at the cut-off step stays");
});
