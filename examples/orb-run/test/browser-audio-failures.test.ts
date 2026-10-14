import assert from "node:assert/strict";
import test, { before } from "node:test";
import { runInContext } from "node:vm";

import * as source from "../src/index.js";
import { buildBrowserSandbox, type BrowserSandbox } from "./browser-host.js";

/**
 * Slice 43 played a healthy session in the browser-shaped sandbox (no Web Audio, no Node builtins). A
 * healthy session never exercises the audio service's refusals, so this slice drives the unhappy paths in
 * the same stubbed-builtin bundle and in the Node build and requires both worlds to agree to the byte:
 * a cue on a bus that is not in the mixer, an asset the service does not know, nonsense instance gains,
 * a muted bus, stop / rewind of a looping cue, a service restricted to a smaller asset list, and the
 * prototype-shaped asset ids a hostile script could ask for.
 *
 * Like `browser-play-path`, the scenario is one self-contained function: its source text is evaluated in
 * the sandbox against the bundle namespace and called with the source module in Node.
 */

type Api = typeof source;

const scenario = async (B: Api): Promise<string> => {
  const out: Record<string, unknown> = {};
  let clock = 0;
  let step = 0;
  const audio = new B.HeadlessAudioService({ now: () => clock, step: () => step });
  const win = B.ORB_RUN_AUDIO_ASSET.win;

  out.ok = await audio.play({ assetId: win, bus: "sfx" });
  out.unknownBus = await audio.play({ assetId: win, bus: "ambience" });
  out.unknownAsset = await audio.play({ assetId: "asset_orbrun_sfx_missing", bus: "sfx" });
  out.prototypeAsset = await audio.play({ assetId: "__proto__", bus: "sfx" });
  out.constructorAsset = await audio.play({ assetId: "constructor", bus: "sfx" });
  out.nanGain = await audio.play({ assetId: win, bus: "sfx", gain: Number.NaN });
  out.negativeGain = await audio.play({ assetId: win, bus: "sfx", gain: -5 });
  out.failuresAfterRefusals = audio.failures();
  out.cueCountAfterRefusals = audio.cueCount;

  audio.setBusMuted("sfx", true);
  await audio.play({ assetId: win, bus: "sfx" });
  audio.setBusMuted("sfx", false);
  out.cuesSoFar = audio.cues();

  // Stop and rewind of a looping cue on the music bus.
  step = 5;
  const loop = await audio.play({ assetId: win, bus: "music", loop: true, entityId: "entity_stop_me" });
  clock = 3;
  step = 9;
  out.stopped = audio.stop({ entityId: "entity_stop_me" });
  out.stoppedAgain = audio.stop({ entityId: "entity_stop_me" });
  out.playingAfterStop = audio.state().activePlaybacks.filter((p) => p.playing).length;
  out.dropped = audio.rewindTo(7);
  out.playingAfterRewind = audio.state().activePlaybacks.filter((p) => p.playing).map((p) => p.playbackId);
  out.loopId = loop.playbackId;
  out.droppedAll = audio.rewindTo(-1);
  out.cuesAfterFullRewind = audio.cues();

  // A service that only knows one clip refuses the rest, in the same words.
  const small = new B.HeadlessAudioService({ now: () => clock, step: () => step, assetIds: [win] });
  out.restricted = await small.play({ assetId: B.ORB_RUN_AUDIO_ASSET.lose });
  out.restrictedKnown = await small.play({ assetId: win });
  out.restrictedFailures = small.failures();

  // The clip table must not leak Object.prototype members as clips.
  out.durations = ["__proto__", "constructor", "toString", "hasOwnProperty", win].map((id) => B.orbRunClipDuration(id));
  const wav = B.createOrbRunAudioBytes();
  out.wavs = B.ORB_RUN_AUDIO_ASSET_IDS.map((id) => {
    const bytes = wav[id]!;
    return [id, bytes.length, String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!)];
  });
  return JSON.stringify(out);
};

type Reply = { success: boolean; playbackId?: string; error?: string };
type Session = {
  ok: Reply;
  unknownBus: Reply;
  unknownAsset: Reply;
  prototypeAsset: Reply;
  constructorAsset: Reply;
  nanGain: Reply;
  negativeGain: Reply;
  failuresAfterRefusals: Array<{ assetId: string; bus: string; error: string }>;
  cueCountAfterRefusals: number;
  cuesSoFar: Array<{ assetId: string; bus: string; gain: number; effectiveGainAtStart: number }>;
  stopped: { success: boolean; stoppedCount: number };
  stoppedAgain: { success: boolean; stoppedCount: number };
  playingAfterStop: number;
  dropped: number;
  playingAfterRewind: string[];
  loopId: string;
  droppedAll: number;
  cuesAfterFullRewind: unknown[];
  restricted: Reply;
  restrictedKnown: Reply;
  restrictedFailures: Array<{ assetId: string; error: string }>;
  durations: Array<number | null>;
  wavs: Array<[string, number, string]>;
};

let sandbox: BrowserSandbox<Api>;
let inBrowserText: string;
let inNodeText: string;
let inBrowser: Session;

before(async () => {
  sandbox = await buildBrowserSandbox<Api>();
  inNodeText = await scenario(source);
  inBrowserText = (await runInContext(`(${scenario.toString()})(OrbRunBundle)`, sandbox.context)) as string;
  inBrowser = JSON.parse(inBrowserText) as Session;
});

test("the scenario's source text reaches the sandbox as written (no compiler helpers, bounded size)", () => {
  const text = scenario.toString();
  assert.doesNotMatch(text, /__awaiter|__generator|__values|__spread|__assign|__rest/, "tsc must not inject helpers the sandbox lacks");
  assert.ok(text.length > 500 && text.length < 8000, `scenario text is ${text.length} chars`);
});

test("refusals and corner cases give the same bytes in the browser sandbox as in Node", () => {
  assert.ok(inBrowserText.length > 1500, "the browser session text is not vacuously short");
  assert.equal(inBrowserText, inNodeText);
  assert.deepEqual(sandbox.calls(), [], "no stubbed Node builtin was called");
});

test("an unknown bus or asset is refused with a plain message and recorded as a failure", () => {
  assert.equal(inBrowser.ok.success, true);
  assert.deepEqual(inBrowser.unknownBus, { success: false, error: 'Unknown audio bus "ambience"' });
  assert.deepEqual(inBrowser.unknownAsset, { success: false, error: 'Audio asset "asset_orbrun_sfx_missing" not found' });
  assert.equal(inBrowser.failuresAfterRefusals.length, 4);
  assert.deepEqual(
    inBrowser.failuresAfterRefusals.map((f) => f.assetId),
    ["asset_orbrun_sfx_win", "asset_orbrun_sfx_missing", "__proto__", "constructor"],
  );
  assert.equal(inBrowser.cueCountAfterRefusals, 3, "refused plays start no cue (ok + two odd-gain plays)");
});

test("prototype-shaped asset ids are not clips", () => {
  assert.equal(inBrowser.prototypeAsset.success, false);
  assert.equal(inBrowser.constructorAsset.success, false);
  assert.deepEqual(inBrowser.durations, [null, null, null, null, 0.6]);
});

test("odd gains are coerced and a muted bus starts the cue silently", () => {
  const [ok, nan, negative, muted] = inBrowser.cuesSoFar;
  assert.equal(ok!.gain, 1);
  assert.equal(nan!.gain, 1, "NaN gain falls back to 1");
  assert.equal(negative!.gain, 0, "negative gain clamps to 0");
  assert.ok(ok!.effectiveGainAtStart > 0);
  assert.equal(muted!.effectiveGainAtStart, 0, "a cue on a muted bus has zero effective gain");
});

test("stop silences a looping cue once and rewinding past the stop revives it", () => {
  assert.deepEqual(inBrowser.stopped, { success: true, stoppedCount: 1 });
  assert.deepEqual(inBrowser.stoppedAgain, { success: true, stoppedCount: 0 });
  assert.equal(inBrowser.dropped, 0, "nothing started after step 7");
  assert.deepEqual(inBrowser.playingAfterRewind.includes(inBrowser.loopId), true, "the stop happened at step 9, after the rewind point");
  assert.equal(inBrowser.droppedAll, inBrowser.cuesSoFar.length + 1, "rewinding to before step 0 forgets every cue, the looping one included");
  assert.deepEqual(inBrowser.cuesAfterFullRewind, []);
});

test("a service restricted to one clip refuses the others and keeps its own failure list", () => {
  assert.deepEqual(inBrowser.restricted, { success: false, error: 'Audio asset "asset_orbrun_sfx_lose" not found' });
  assert.equal(inBrowser.restrictedKnown.success, true);
  assert.equal(inBrowser.restrictedFailures.length, 1);
});

test("every synthetic clip is a RIFF file in the sandbox too", () => {
  assert.equal(inBrowser.wavs.length, source.ORB_RUN_AUDIO_ASSET_IDS.length);
  for (const [, length, magic] of inBrowser.wavs) {
    assert.equal(magic, "RIFF");
    assert.ok(length > 44);
  }
});
