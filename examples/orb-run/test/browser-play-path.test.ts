import assert from "node:assert/strict";
import test, { before } from "node:test";
import { runInContext } from "node:vm";

import * as source from "../src/index.js";
import { buildBrowserSandbox, type BrowserSandbox } from "./browser-host.js";

/**
 * Slice 42 proved that *replays* (record, play, verify) run in a browser-shaped host. A replay drives the
 * simulation through input only, so it never touches the parts of the game a player meets around the run:
 * the HUD, the save / quick-load path with its hostile-input validation, the audio service and the runner
 * animator. This test plays one scripted session through the same stubbed-builtin browser bundle and in
 * the Node build and requires the two to agree to the byte, then checks the session itself.
 *
 * The scenario is one self-contained function: its source text is evaluated inside the sandbox against the
 * bundle's namespace, and called with the source module in Node, so both worlds run literally the same code.
 */

type Api = typeof source;

const scenario = async (B: Api): Promise<string> => {
  const out: Record<string, unknown> = {};
  const simulation = await B.startOrbRunSimulation();
  try {
    out.openingHud = B.renderOrbRunHudText(B.buildOrbRunHud(simulation));
    out.audioAtStart = B.orbRunAudio(simulation).state().initialized;

    const route = B.ORB_RUN_WINNING_ROUTE;
    for (const target of route.slice(0, 2)) B.walkTo(simulation, target);
    const save = JSON.parse(JSON.stringify(B.captureOrbRunSave(simulation))) as ReturnType<Api["captureOrbRunSave"]>;
    out.save = save;
    out.midSummary = B.summarizeOrbRun(simulation);
    out.midHud = B.renderOrbRunHudText(B.buildOrbRunHud(simulation));
    out.midAnimation = B.orbRunAnimator(simulation).state();

    for (const target of route.slice(2)) B.walkTo(simulation, target);
    out.finalSummary = B.summarizeOrbRun(simulation);
    out.finalSave = B.captureOrbRunSave(simulation);
    const won = B.buildOrbRunHud(simulation);
    out.wonBanner = won.banner;
    out.wonHud = B.renderOrbRunHudText(won);
    out.cuesAtWin = B.orbRunAudio(simulation).cues().map((cue) => cue.assetId);

    // Quick-load back to the mid-run save: the state, the clock and the HUD follow it.
    await B.restoreOrbRunSave(simulation, save);
    out.loadedStep = simulation.step;
    out.loadedIsTheSave = JSON.stringify(B.captureOrbRunSave(simulation)) === JSON.stringify(save);
    out.loadedHud = B.renderOrbRunHudText(B.buildOrbRunHud(simulation));
    out.cuesAfterLoad = B.orbRunAudio(simulation).cues().map((cue) => cue.assetId);
    out.audioFailures = B.orbRunAudio(simulation).failures().length;

    // A hostile save is refused with a structured error and changes nothing.
    const before = JSON.stringify(B.captureOrbRunSave(simulation));
    try {
      await B.restoreOrbRunSave(simulation, { ...save, smuggled: true } as unknown as typeof save);
      out.hostile = "accepted";
    } catch (error) {
      out.hostile = (error as { code?: string }).code ?? "no-code";
    }
    out.hostileChangedNothing = JSON.stringify(B.captureOrbRunSave(simulation)) === before;

    // Finish the game again from the loaded save: same ending as the first time.
    for (const target of route.slice(2)) B.walkTo(simulation, target);
    out.replayedFinalSave = B.captureOrbRunSave(simulation);
  } finally {
    await simulation.dispose();
  }

  // A fuzzed session (random, seeking and mixed drivers) ends in the same state in both worlds.
  const strategies = ["random", "seek", "mixed"] as const;
  const fuzzed: unknown[] = [];
  for (let seed = 1; seed <= 3; seed += 1) {
    const fuzz = await B.startOrbRunSimulation();
    try {
      B.driveOrbRunFuzz(fuzz, { seed, steps: 150 + seed * 20, strategy: strategies[seed % 3]! });
      fuzzed.push(B.captureOrbRunSave(fuzz));
    } finally {
      await fuzz.dispose();
    }
  }
  out.fuzzed = fuzzed;
  return JSON.stringify(out);
};

type Session = {
  openingHud: string;
  audioAtStart: boolean;
  save: { step: number };
  midSummary: { status: string; collectedCount: number; step: number };
  midHud: string;
  midAnimation: unknown;
  finalSummary: { status: string; collectedCount: number; totalOrbs: number };
  finalSave: unknown;
  wonBanner: { kind: string; title: string } | null;
  wonHud: string;
  cuesAtWin: string[];
  loadedStep: number;
  loadedIsTheSave: boolean;
  loadedHud: string;
  cuesAfterLoad: string[];
  audioFailures: number;
  hostile: string;
  hostileChangedNothing: boolean;
  replayedFinalSave: unknown;
  fuzzed: unknown[];
};

let sandbox: BrowserSandbox<Api>;
let inBrowser: Session;
let inNode: Session;
let inBrowserText: string;
let inNodeText: string;

before(async () => {
  sandbox = await buildBrowserSandbox<Api>();
  inNodeText = await scenario(source);
  inBrowserText = (await runInContext(`(${scenario.toString()})(OrbRunBundle)`, sandbox.context)) as string;
  inNode = JSON.parse(inNodeText) as Session;
  inBrowser = JSON.parse(inBrowserText) as Session;
});

test("the scenario's source text reaches the sandbox as written (no compiler helpers, bounded size)", () => {
  // The scenario is shipped as `scenario.toString()`. If the compiler target ever downlevels async/spread it
  // would inject helpers (`__awaiter`, ...) that only exist at the top of the compiled test module, and the
  // sandbox would fail with a ReferenceError instead of a useful assertion.
  const text = scenario.toString();
  assert.doesNotMatch(text, /__awaiter|__generator|__values|__spread|__assign|__rest/);
  assert.ok(text.length > 1000 && text.length < 12000, `scenario text is ${text.length} chars`);
});

test("the whole session (HUD, save, quick-load, audio, animation, fuzz) is byte-identical in the browser sandbox", () => {
  assert.ok(inBrowserText.length > 3000, `the browser session text is not vacuously short (${inBrowserText.length} chars)`);
  assert.equal(inBrowserText, inNodeText);
  assert.deepEqual(sandbox.calls(), [], "no stubbed Node builtin was called while playing");
});

test("the HUD tells the story of the run inside the sandbox", () => {
  assert.equal(inBrowser.openingHud, "Orbs 0/3 | 0:20 | Exit locked | Orb SE 5.7 m");
  assert.match(inBrowser.midHud, /^Orbs 2\/3 \| /);
  assert.equal(inBrowser.finalSummary.status, "won");
  assert.equal(inBrowser.finalSummary.collectedCount, inBrowser.finalSummary.totalOrbs);
  assert.equal(inBrowser.wonBanner?.kind, "won");
  assert.match(inBrowser.wonHud, /^Orbs 3\/3 \| /);
});

test("quick-load in the sandbox returns the exact mid-run state, HUD and sound included", () => {
  assert.equal(inBrowser.loadedStep, inBrowser.save.step);
  assert.equal(inBrowser.loadedIsTheSave, true, "capture(restore(save)) is the save");
  assert.equal(inBrowser.loadedHud, inBrowser.midHud);
  assert.equal(inBrowser.audioAtStart, true, "the audio service started without Web Audio or Node");
  assert.equal(inBrowser.audioFailures, 0);
  assert.ok(inBrowser.cuesAtWin.length > inBrowser.cuesAfterLoad.length, "cues after the loaded step were rewound");
  assert.deepEqual(inBrowser.cuesAfterLoad, inBrowser.cuesAtWin.slice(0, inBrowser.cuesAfterLoad.length), "the kept cues are a prefix of the first timeline");
  assert.deepEqual(inBrowser.replayedFinalSave, inBrowser.finalSave, "playing on from the loaded save reproduces the first ending");
});

test("a hostile save is refused in the sandbox with the structured error code, and nothing changes", () => {
  assert.equal(inBrowser.hostile, "ORB_RUN_SAVE_INVALID");
  assert.equal(inBrowser.hostileChangedNothing, true);
});

test("the runner animator and three fuzzed sessions run in the sandbox and match Node", () => {
  assert.ok(inBrowser.midAnimation && typeof inBrowser.midAnimation === "object", "the animator reports its state");
  assert.equal(inBrowser.fuzzed.length, 3);
  assert.deepEqual(inBrowser.fuzzed, inNode.fuzzed);
});
