import { ORB_RUN_WINNING_ROUTE, summarizeOrbRun, walkTo } from "./game.js";
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
