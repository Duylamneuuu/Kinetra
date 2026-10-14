import assert from "node:assert/strict";
import test from "node:test";

import {
  ORB_RUN_AUDIO_ASSET,
  ORB_RUN_AUDIO_BUS,
  ORB_RUN_WINNING_ROUTE,
  captureOrbRunSave,
  digestOrbRunState,
  orbRunAudio,
  restoreOrbRunSave,
  startOrbRunSimulation,
  summarizeOrbRun,
  walkTo,
  type HeadlessSceneSimulation,
  type OrbRunSaveData,
} from "../src/index.js";

/**
 * Slice 5 left "mixer state across a save/load" as not proven. This pins the rule: the audio mix (bus gain / mute) is a
 * *player preference* of the running session, not game state. It is never in a save, never in a replay digest, and a
 * quick-load into the same session keeps it, while a fresh session starts from the authored mix.
 */

const SFX = ORB_RUN_AUDIO_BUS.sfx;
const AUTHORED_SFX_GAIN = 0.9;

function roundTrip(save: OrbRunSaveData): OrbRunSaveData {
  return JSON.parse(JSON.stringify(save)) as OrbRunSaveData;
}

async function playWholeRoute(simulation: HeadlessSceneSimulation): Promise<void> {
  for (const target of ORB_RUN_WINNING_ROUTE) walkTo(simulation, target);
}

/** Effective gain of each pickup cue, as a multiple of the cue's own instance gain (the bus chain's gain). */
function pickupBusGains(simulation: HeadlessSceneSimulation): number[] {
  return orbRunAudio(simulation)
    .cues()
    .filter((cue) => (ORB_RUN_AUDIO_ASSET.pickups as readonly string[]).includes(cue.assetId))
    .map((cue) => cue.effectiveGainAtStart / cue.gain);
}

test("muting sfx changes what is heard, never the game: same save, same replay digest, same cues", async () => {
  const loud = await startOrbRunSimulation();
  const muted = await startOrbRunSimulation();
  try {
    orbRunAudio(muted).setBusMuted(SFX, true);
    orbRunAudio(muted).setBusGain(ORB_RUN_AUDIO_BUS.music, 0.05);
    await playWholeRoute(loud);
    await playWholeRoute(muted);

    assert.equal(summarizeOrbRun(loud).status, "won");
    assert.deepEqual(summarizeOrbRun(muted), summarizeOrbRun(loud));
    assert.deepEqual(captureOrbRunSave(muted), captureOrbRunSave(loud), "the save has no trace of the mix");
    assert.equal(digestOrbRunState(muted), digestOrbRunState(loud), "the replay digest ignores the mix");

    // The same five cues started in both sessions; only their loudness differs.
    const heard = orbRunAudio(loud).cues();
    const silenced = orbRunAudio(muted).cues();
    assert.equal(heard.length, 5);
    assert.deepEqual(
      silenced.map(({ effectiveGainAtStart: _ignored, ...rest }) => rest),
      heard.map(({ effectiveGainAtStart: _ignored, ...rest }) => rest),
    );
    assert.ok(heard.every((cue) => cue.effectiveGainAtStart > 0));
    assert.ok(silenced.every((cue) => cue.effectiveGainAtStart === 0));
    assert.ok(heard.every((cue) => cue.effectiveGainAtStart === cue.gain * AUTHORED_SFX_GAIN));
  } finally {
    await loud.dispose();
    await muted.dispose();
  }
});

test("a save never carries the mix: no bus, mute or gain field anywhere in it", async () => {
  const simulation = await startOrbRunSimulation();
  try {
    orbRunAudio(simulation).setBusMuted(SFX, true);
    orbRunAudio(simulation).setBusGain(SFX, 0.123);
    for (const target of ORB_RUN_WINNING_ROUTE.slice(0, 2)) walkTo(simulation, target);
    const text = JSON.stringify(captureOrbRunSave(simulation));
    for (const needle of ["muted", "0.123", '"bus"', "mixer", "effectiveGain"]) {
      assert.ok(!text.includes(needle), `the save must not mention ${needle}`);
    }
  } finally {
    await simulation.dispose();
  }
});

test("a save restored into a fresh session starts from the authored mix, not the mix it was saved under", async () => {
  const first = await startOrbRunSimulation();
  const second = await startOrbRunSimulation();
  try {
    orbRunAudio(first).setBusMuted(SFX, true);
    for (const target of ORB_RUN_WINNING_ROUTE.slice(0, 2)) walkTo(first, target);
    const save = roundTrip(captureOrbRunSave(first));
    assert.equal(orbRunAudio(first).mixer.effectiveGain(SFX), 0);

    await restoreOrbRunSave(second, save);
    assert.equal(orbRunAudio(second).mixer.effectiveGain(SFX), AUTHORED_SFX_GAIN, "the new session is not muted");
    assert.equal(orbRunAudio(second).cues().length, 0, "restoring replays no cue");

    // The third orb is picked up in the new session, at the authored loudness.
    for (const target of ORB_RUN_WINNING_ROUTE.slice(2)) walkTo(second, target);
    assert.equal(summarizeOrbRun(second).status, "won");
    assert.ok(pickupBusGains(second).length >= 1);
    assert.ok(pickupBusGains(second).every((gain) => Math.abs(gain - AUTHORED_SFX_GAIN) < 1e-12));
    // ...while the muted session finishes the same game in silence.
    for (const target of ORB_RUN_WINNING_ROUTE.slice(2)) walkTo(first, target);
    assert.ok(pickupBusGains(first).every((gain) => gain === 0));
    assert.equal(digestOrbRunState(first).length, 64);
    assert.deepEqual(captureOrbRunSave(first), captureOrbRunSave(second), "both sessions end in the same game state");
  } finally {
    await first.dispose();
    await second.dispose();
  }
});

test("a quick-load inside the same session keeps the player's mix", async () => {
  const simulation = await startOrbRunSimulation();
  try {
    for (const target of ORB_RUN_WINNING_ROUTE.slice(0, 1)) walkTo(simulation, target);
    const save = roundTrip(captureOrbRunSave(simulation));
    await playWholeRoute(simulation);
    assert.equal(summarizeOrbRun(simulation).status, "won");

    // The player mutes sfx and drags the music down, then quick-loads the earlier save.
    orbRunAudio(simulation).setBusMuted(SFX, true);
    orbRunAudio(simulation).setBusGain(ORB_RUN_AUDIO_BUS.music, 0.2);
    await restoreOrbRunSave(simulation, save);

    assert.equal(orbRunAudio(simulation).mixer.effectiveGain(SFX), 0, "still muted after the load");
    assert.equal(orbRunAudio(simulation).mixer.effectiveGain(ORB_RUN_AUDIO_BUS.music), 0.2);

    // Playing on from the loaded save rebuilds the win, silently for the pickups that are heard again.
    for (const target of ORB_RUN_WINNING_ROUTE.slice(1)) walkTo(simulation, target);
    assert.equal(summarizeOrbRun(simulation).status, "won");
    const after = orbRunAudio(simulation)
      .cues()
      .filter((cue) => cue.step > save.step);
    assert.ok(after.length >= 3);
    assert.ok(after.every((cue) => cue.effectiveGainAtStart === 0));
  } finally {
    await simulation.dispose();
  }
});
