import type { AcceptanceManifest } from "@kinetra/verification";

import { ORB_RUN_MAX_STEPS_PER_CALL } from "./acceptance-probe.js";
import { ORB_RUN_WINNING_ROUTE, summarizeOrbRun, walkTo } from "./game.js";
import { ORB_RUN_SCENE_ID } from "./ids.js";
import { recordOrbRunReplay, type OrbRunReplay } from "./replay.js";

/**
 * The golden recordings shipped in `acceptance/replays/`, produced by the
 * playtest bot (semantic input only). `pnpm --filter @kinetra/example-orb-run
 * snapshot` writes them to disk; a test replays the committed files and also
 * checks they equal a fresh recording, so a stale digest cannot hide.
 */
export async function createOrbRunReplays(): Promise<{ win: OrbRunReplay; timeout: OrbRunReplay }> {
  const win = await recordOrbRunReplay((simulation) => {
    const finished = () => summarizeOrbRun(simulation).status !== "playing";
    for (const target of ORB_RUN_WINNING_ROUTE) {
      walkTo(simulation, target, { stopWhen: finished });
      if (finished()) return;
    }
    simulation.advance(1);
  });
  // Idle until the 20 s clock (600 steps at 30 Hz) runs out, then a few frozen steps.
  const timeout = await recordOrbRunReplay((simulation) => {
    simulation.advance(610);
  });
  return { win, timeout };
}

/**
 * Turns a recording into an `AcceptanceManifest` for the engine `AcceptanceRunner`: it re-presses the recorded held
 * sets through the probe's `input` steps, advances with `runtime.step`, and pins `state.replay.digest` (the same
 * `digestOrbRunState`) at every checkpoint plus the recorded outcome. A gameplay change therefore fails the manifest
 * at the *first checkpoint* that moved, with the runner's own diagnostic, no replay-specific tooling needed.
 */
export function createOrbRunReplayManifest(replay: OrbRunReplay, suite: string): AcceptanceManifest {
  const steps: AcceptanceManifest["steps"] = [{ type: "runtime.start", sceneId: ORB_RUN_SCENE_ID }];
  const checkpointAt = new Map(replay.checkpoints.map((checkpoint) => [checkpoint.step, checkpoint.digest]));
  // A held-set change at 1-based step `s` happens after `s - 1` steps ran; a checkpoint at step `c` after `c` steps.
  const stops = new Set<number>([...checkpointAt.keys(), ...replay.inputs.map((input) => input.step - 1)]);
  let done = 0;
  let held: string[] = [];
  const advanceTo = (target: number): void => {
    while (done < target) {
      const chunk = Math.min(target - done, ORB_RUN_MAX_STEPS_PER_CALL);
      steps.push({ type: "runtime.step", steps: chunk });
      done += chunk;
    }
  };
  for (const stop of [...stops].sort((a, b) => a - b)) {
    advanceTo(stop);
    const digest = checkpointAt.get(stop);
    if (digest !== undefined) {
      steps.push({ type: "assert.equal", path: "state.replay.step", expected: stop });
      steps.push({ type: "assert.equal", path: "state.replay.digest", expected: digest });
    }
    const change = replay.inputs.find((input) => input.step - 1 === stop);
    if (change) {
      for (const action of held) steps.push({ type: "input", action, phase: "release" });
      held = Object.keys(change.actions);
      for (const action of held) steps.push({ type: "input", action, phase: "press", value: change.actions[action]! });
    }
  }
  advanceTo(replay.totalSteps);
  steps.push({ type: "assert.equal", path: "state.game.status", expected: replay.outcome.status });
  steps.push({ type: "assert.equal", path: "state.game.collectedCount", expected: replay.outcome.collectedCount });
  steps.push({ type: "assert.equal", path: "state.game.totalOrbs", expected: replay.outcome.totalOrbs });
  steps.push({ type: "runtime.stop" });
  return { schemaVersion: 1, suite, seed: 0, target: "runtime", steps };
}
