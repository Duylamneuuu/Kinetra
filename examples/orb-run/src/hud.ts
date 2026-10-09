import { ORB_RUN_DEFAULT_RULES, type OrbRunRules } from "./authoring.js";
import { summarizeOrbRun, type OrbRunSummary } from "./game.js";
import { ORB_RUN_ENTITY, ORB_RUN_ORB_IDS, ORB_RUN_RULES_COMPONENT } from "./ids.js";
import { parseOrbRunRules, type OrbRunStatus } from "./scripts.js";
import type { HeadlessSceneSimulation } from "./simulation.js";

/**
 * HUD contract for Orb Run.
 *
 * The HUD is a *pure function of gameplay state*: `computeOrbRunHud` takes the
 * run summary (what the manager script reports), the authored rules and the
 * positions of the things worth pointing at, and returns a plain, JSON-safe
 * model (texts, fractions, urgency, a direction marker, a result banner). A
 * renderer (the Electron player's DOM overlay, a test, an acceptance step)
 * only has to draw it. Nothing here touches Three.js or the DOM, so the HUD can
 * be proven in Node and survives a save/load round trip by construction.
 */

/** At or below this many seconds left the timer is `critical`. */
export const ORB_RUN_HUD_CRITICAL_SECONDS = 5;
/** At or below this fraction of the time limit left the timer is `warning`. */
export const ORB_RUN_HUD_WARNING_FRACTION = 0.5;

export type HudTimerUrgency = "normal" | "warning" | "critical" | "expired";
export type HudObjectiveKind = "collectOrbs" | "reachExit" | "won" | "lost";
export type HudCompass = "N" | "NE" | "E" | "SE" | "S" | "SW" | "W" | "NW";
export type HudMarkerKind = "orb" | "exit";

export interface OrbRunHudMarker {
  kind: HudMarkerKind;
  /** Entity the marker points at (the nearest uncollected orb, or the exit). */
  targetEntityId: string;
  /** Horizontal distance in metres, rounded to 0.01. */
  distance: number;
  /** Clockwise degrees from "forward" (-z) in [0, 360), rounded to 0.1. */
  bearingDegrees: number;
  compass: HudCompass;
  text: string;
}

export interface OrbRunHud {
  objective: { kind: HudObjectiveKind; text: string };
  orbs: { collected: number; total: number; remaining: number; complete: boolean; text: string };
  timer: {
    remainingSeconds: number;
    /** Whole seconds shown on screen (rounded up, so the clock never shows 0:00 while time is left). */
    displaySeconds: number;
    /** remaining / limit, clamped to [0, 1], rounded to 4 decimals. */
    fraction: number;
    urgency: HudTimerUrgency;
    text: string;
  };
  exit: { unlocked: boolean; text: string };
  marker: OrbRunHudMarker | null;
  banner: { kind: "won" | "lost"; title: string; subtitle: string } | null;
}

export interface OrbRunHudMarkerTarget {
  kind: HudMarkerKind;
  entityId: string;
  /** Horizontal position as [x, z]. */
  position: readonly [number, number];
}

export interface OrbRunHudInput {
  summary: OrbRunSummary;
  rules: OrbRunRules;
  /** Uncollected orbs and the exit with their runtime positions; the HUD picks what to point at. */
  targets?: readonly OrbRunHudMarkerTarget[];
}

const COMPASS: readonly HudCompass[] = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** `m:ss` for a whole number of seconds. */
export function formatClock(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) {
    throw new RangeError(`Clock seconds must be finite and >= 0, got ${String(totalSeconds)}`);
  }
  const whole = Math.floor(totalSeconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

export function compassFor(bearingDegrees: number): HudCompass {
  const normalized = ((bearingDegrees % 360) + 360) % 360;
  return COMPASS[Math.round(normalized / 45) % 8]!;
}

function timerUrgency(status: OrbRunStatus, remaining: number, limit: number): HudTimerUrgency {
  if (status === "lost" || remaining <= 0) return "expired";
  if (status === "won") return "normal";
  if (remaining <= ORB_RUN_HUD_CRITICAL_SECONDS) return "critical";
  if (remaining <= limit * ORB_RUN_HUD_WARNING_FRACTION) return "warning";
  return "normal";
}

function pickMarker(input: OrbRunHudInput): OrbRunHudMarker | null {
  const { summary, targets } = input;
  if (summary.status !== "playing" || !targets) return null;
  const wanted: HudMarkerKind = summary.collectedCount >= summary.totalOrbs ? "exit" : "orb";
  let best: { target: OrbRunHudMarkerTarget; distance: number } | undefined;
  for (const target of targets) {
    if (target.kind !== wanted) continue;
    const distance = Math.hypot(target.position[0] - summary.player[0], target.position[1] - summary.player[2]);
    // Ties break on entity id so the marker never flickers between equidistant orbs.
    if (!best || distance < best.distance || (distance === best.distance && target.entityId < best.target.entityId)) {
      best = { target, distance };
    }
  }
  if (!best) return null;
  const dx = best.target.position[0] - summary.player[0];
  const dz = best.target.position[1] - summary.player[2];
  const bearing = best.distance === 0 ? 0 : ((Math.atan2(dx, -dz) * 180) / Math.PI + 360) % 360;
  const bearingDegrees = round(bearing, 1) % 360;
  const distance = round(best.distance, 2);
  const compass = compassFor(bearingDegrees);
  return {
    kind: wanted,
    targetEntityId: best.target.entityId,
    distance,
    bearingDegrees,
    compass,
    text: `${wanted === "exit" ? "Exit" : "Orb"} ${compass} ${distance.toFixed(1)} m`,
  };
}

export function computeOrbRunHud(input: OrbRunHudInput): OrbRunHud {
  const { summary, rules } = input;
  const remainingSeconds = Math.max(0, summary.remainingSeconds);
  // Tolerate float drift from accumulating 1/30 s steps (29.999999999999996 must read 0:30).
  const displaySeconds = Math.ceil(remainingSeconds - 1e-9);
  const remaining = summary.totalOrbs - summary.collectedCount;

  const objective: OrbRunHud["objective"] =
    summary.status === "won"
      ? { kind: "won", text: "Run complete" }
      : summary.status === "lost"
        ? { kind: "lost", text: "Time's up" }
        : remaining > 0
          ? { kind: "collectOrbs", text: `Collect the orbs (${remaining} left)` }
          : { kind: "reachExit", text: "Reach the exit" };

  const banner: OrbRunHud["banner"] =
    summary.status === "won"
      ? {
          kind: "won",
          title: "You win!",
          subtitle: `${summary.collectedCount}/${summary.totalOrbs} orbs in ${summary.elapsedSeconds.toFixed(1)} s`,
        }
      : summary.status === "lost"
        ? {
            kind: "lost",
            title: "Time's up",
            subtitle: `${summary.collectedCount}/${summary.totalOrbs} orbs collected`,
          }
        : null;

  return {
    objective,
    orbs: {
      collected: summary.collectedCount,
      total: summary.totalOrbs,
      remaining,
      complete: remaining === 0,
      text: `Orbs ${summary.collectedCount}/${summary.totalOrbs}`,
    },
    timer: {
      remainingSeconds: round(remainingSeconds, 3),
      displaySeconds,
      fraction: round(Math.min(1, Math.max(0, remainingSeconds / rules.timeLimitSeconds)), 4),
      urgency: timerUrgency(summary.status, remainingSeconds, rules.timeLimitSeconds),
      text: formatClock(displaySeconds),
    },
    exit: {
      unlocked: summary.exitUnlocked,
      text: summary.exitUnlocked ? "Exit open" : "Exit locked",
    },
    marker: pickMarker(input),
    banner,
  };
}

/** One-line plain-text rendering of a HUD (what a log or a text-mode overlay would print). */
export function renderOrbRunHudText(hud: OrbRunHud): string {
  const parts = [hud.orbs.text, hud.timer.text, hud.exit.text];
  if (hud.marker) parts.push(hud.marker.text);
  if (hud.banner) parts.push(`${hud.banner.title} - ${hud.banner.subtitle}`);
  return parts.join(" | ");
}

/** The authored rules of a running simulation, read from the manager's `OrbRunRules` component. */
export function readOrbRunRules(simulation: HeadlessSceneSimulation): OrbRunRules {
  const authored = simulation.getAuthoredComponent(ORB_RUN_ENTITY.manager, ORB_RUN_RULES_COMPONENT);
  return authored === undefined ? { ...ORB_RUN_DEFAULT_RULES } : parseOrbRunRules(authored);
}

/** Build the HUD of a running Orb Run simulation. */
export function buildOrbRunHud(simulation: HeadlessSceneSimulation): OrbRunHud {
  const summary = summarizeOrbRun(simulation);
  const collected = new Set(
    (simulation.scriptState(ORB_RUN_ENTITY.manager)?.state?.collectedOrbIds as string[] | undefined) ?? [],
  );
  const targets: OrbRunHudMarkerTarget[] = [];
  for (const orbId of ORB_RUN_ORB_IDS) {
    if (collected.has(orbId)) continue;
    const position = simulation.getPosition(orbId);
    if (position) targets.push({ kind: "orb", entityId: orbId, position: [position[0], position[2]] });
  }
  const exit = simulation.getPosition(ORB_RUN_ENTITY.exit);
  if (exit) targets.push({ kind: "exit", entityId: ORB_RUN_ENTITY.exit, position: [exit[0], exit[2]] });
  return computeOrbRunHud({ summary, rules: readOrbRunRules(simulation), targets });
}
