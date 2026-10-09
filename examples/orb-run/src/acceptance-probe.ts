import type { ProjectDocument } from "@kinetra/project-model";
import type {
  RuntimeInput,
  RuntimeLog,
  RuntimeMetrics,
  RuntimeProbe,
  RuntimeSnapshot,
} from "@kinetra/verification";

import { createOrbRunProject } from "./authoring.js";
import type { OrbRunAnimatorOptions } from "./animator.js";
import { buildOrbRunHud } from "./hud.js";
import {
  captureOrbRunSave,
  restoreOrbRunSave,
  orbRunAnimator,
  orbRunAudio,
  startOrbRunSimulation,
  summarizeOrbRun,
  type OrbRunSaveData,
} from "./game.js";
import { ORB_RUN_ENTITY, ORB_RUN_EVENT, ORB_RUN_SCENE_ID } from "./ids.js";
import type { HeadlessSceneSimulation } from "./simulation.js";

/** Upper bound for one `step`/`wait`/`hold` (matches the player's `runtime.step`: ~10 minutes at 60 Hz). */
export const ORB_RUN_MAX_STEPS_PER_CALL = 36_000;

/**
 * `RuntimeProbe` for Orb Run over the headless simulation, so the engine's own
 * `AcceptanceRunner` can execute an `AcceptanceManifest` against the game in
 * plain Node (no renderer, no Electron).
 *
 * Time is virtual and deterministic: `wait` and `input` "hold" advance the
 * simulation by whole fixed steps (`round(ms / 1000 / fixedDeltaSeconds)`).
 * Anything the headless game cannot do (frames, vector input, a different
 * scene, a non-fixed delta) throws, so a manifest that asks for it fails
 * loudly instead of passing without evidence.
 *
 * Snapshot shape (paths an `assert.equal` / `assert.near` step can read):
 * - `state.game.<status|collectedCount|totalOrbs|exitUnlocked|elapsedSeconds|remainingSeconds|step>`
 * - `state.entities.<EntityName>.position.<0|1|2>` and `.script` (the entity's script state)
 * - `state.events.<orbCollected|exitUnlocked|won|lost>`: how many times each gameplay event fired
 * - `state.hud.<objective|orbs|timer|exit|marker|banner>.*`: the HUD model of `computeOrbRunHud` (`marker` and `banner` are `null` when absent)
 * - `state.audio.playedCount`, `.played.<assetId>` (cue count per asset), `.failedCount`, `.cues.<n>.<assetId|bus|step|effectiveGainAtStart>`,
 *   `.buses.<master|music|sfx>.<gain|effectiveGain|muted>` and `.playbacks.<n>` (engine `AudioPlaybackState`)
 * - `state.animation.*`: the runner's locomotion + foot IK (`OrbRunAnimator`): `speed`, `smoothedSpeed`, `weights.<idle|walk|run>`, `dominant`,
 *   `transitions`, `visited`, `pelvis.<0|1|2>`, `pelvisDrop`, `feet.<left|right>.<groundY|targetY|ankleY|error|planted|reachable|converged>`,
 *   `maxBoneLengthError`, `legsValid`, `failedCount`; a pose that could not be computed is also an `animation.failed` warning log
 * - `audio.play` / `audio.stop` / `audio.setBusGain` / `audio.setBusMuted` steps drive the same headless mixer;
 *   a refused `audio.play` (unknown bus/asset) throws so the manifest fails instead of passing silently
 * - logs: every started cue also appears as an `audio.played` info log (same message the Electron player logs)
 */
export class OrbRunHeadlessProbe implements RuntimeProbe {
  readonly #project: ProjectDocument;
  readonly #animation: OrbRunAnimatorOptions;
  #simulation: HeadlessSceneSimulation | undefined;
  #paused = false;
  #slots = new Map<string, OrbRunSaveData>();
  #previousLogs: RuntimeLog[] = [];

  constructor(options: { project?: ProjectDocument; animation?: OrbRunAnimatorOptions } = {}) {
    this.#project = options.project ?? createOrbRunProject();
    this.#animation = options.animation ?? {};
  }

  /** The running simulation (for tests that want to cross-check the probe). */
  get simulation(): HeadlessSceneSimulation | undefined {
    return this.#simulation;
  }

  async start(sceneId: string, _seed: number): Promise<void> {
    if (sceneId !== ORB_RUN_SCENE_ID) {
      throw new Error(`Orb Run probe can only start scene "${ORB_RUN_SCENE_ID}", got "${sceneId}"`);
    }
    await this.stop();
    this.#simulation = await startOrbRunSimulation(this.#project, this.#animation);
    this.#paused = false;
  }

  async stop(): Promise<void> {
    if (!this.#simulation) return;
    this.#previousLogs.push(...this.#mapLogs(this.#simulation));
    await this.#simulation.dispose();
    this.#simulation = undefined;
  }

  async pause(): Promise<void> {
    this.#require();
    this.#paused = true;
  }

  async resume(): Promise<void> {
    this.#require();
    this.#paused = false;
  }

  async input(event: RuntimeInput): Promise<void> {
    const simulation = this.#require();
    if (Array.isArray(event.value)) {
      throw new Error(`Orb Run actions are scalar; "${event.action}" got a vector value`);
    }
    // The Electron player drops every input while paused (`runtime.inputBlockedWhilePaused`),
    // so a press queued during a pause must not leak into the first step after resume.
    if (this.#paused) return;
    const value = event.value ?? 1;
    switch (event.phase) {
      case "press":
        simulation.setAction(event.action, value);
        return;
      case "release":
        simulation.setAction(event.action, 0);
        return;
      case "hold": {
        // Validate the duration before pressing: a rejected hold must not leave the action stuck down.
        const steps = this.#stepsFor(event.durationMs ?? 0);
        simulation.setAction(event.action, value);
        try {
          this.#advance(steps);
        } finally {
          simulation.setAction(event.action, 0);
        }
        return;
      }
    }
  }

  async playAudio(params: {
    assetId: string;
    bus?: string;
    loop?: boolean;
    gain?: number;
    entityId?: string;
  }): Promise<void> {
    const result = await orbRunAudio(this.#require()).play(params);
    if (!result.success) throw new Error(result.error ?? `audio.play failed for "${params.assetId}"`);
  }

  async stopAudio(params: { playbackId?: string; entityId?: string } = {}): Promise<void> {
    orbRunAudio(this.#require()).stop(params);
  }

  async setAudioBusGain(busId: string, gain: number): Promise<void> {
    orbRunAudio(this.#require()).setBusGain(busId, gain);
  }

  async setAudioBusMuted(busId: string, muted: boolean): Promise<void> {
    orbRunAudio(this.#require()).setBusMuted(busId, muted);
  }

  async wait(milliseconds: number): Promise<void> {
    this.#advance(this.#stepsFor(milliseconds));
  }

  async step(steps = 1, deltaSeconds?: number): Promise<void> {
    const simulation = this.#require();
    // Same bounds as the Electron player's `runtime.step`, so a manifest that
    // the player rejects is rejected here too (a NaN/negative count would
    // otherwise be a silent no-op and a huge one would hang the run).
    if (!Number.isInteger(steps) || steps < 0 || steps > ORB_RUN_MAX_STEPS_PER_CALL) {
      throw new TypeError(`steps must be an integer from 0 to ${ORB_RUN_MAX_STEPS_PER_CALL}, got ${String(steps)}`);
    }
    if (deltaSeconds !== undefined && (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0)) {
      throw new TypeError(`deltaSeconds must be a finite number > 0, got ${String(deltaSeconds)}`);
    }
    if (deltaSeconds !== undefined && Math.abs(deltaSeconds - simulation.fixedDeltaSeconds) > 1e-9) {
      throw new Error(
        `Orb Run runs at a fixed step of ${simulation.fixedDeltaSeconds}s; runtime.step asked for ${deltaSeconds}s`,
      );
    }
    this.#advance(steps);
  }

  async snapshot(): Promise<RuntimeSnapshot> {
    const simulation = this.#simulation;
    if (!simulation) return { running: false, state: {} };
    const entities: Record<string, { position: number[]; script?: Record<string, unknown> }> = {};
    const names: Record<string, string> = {
      [ORB_RUN_ENTITY.player]: "Player",
      [ORB_RUN_ENTITY.orbA]: "OrbA",
      [ORB_RUN_ENTITY.orbB]: "OrbB",
      [ORB_RUN_ENTITY.orbC]: "OrbC",
      [ORB_RUN_ENTITY.exit]: "Exit",
      [ORB_RUN_ENTITY.manager]: "OrbRunManager",
    };
    for (const [entityId, name] of Object.entries(names)) {
      const position = simulation.getPosition(entityId);
      const script = simulation.scriptState(entityId)?.state;
      entities[name] = {
        position: position ?? [],
        ...(script ? { script: structuredClone(script) } : {}),
      };
    }
    const events = {
      orbCollected: simulation.events(ORB_RUN_EVENT.orbCollected).length,
      exitUnlocked: simulation.events(ORB_RUN_EVENT.exitUnlocked).length,
      won: simulation.events(ORB_RUN_EVENT.won).length,
      lost: simulation.events(ORB_RUN_EVENT.lost).length,
    };
    const { player: _player, ...game } = summarizeOrbRun(simulation);
    const audio = orbRunAudio(simulation);
    const audioState = audio.state();
    const cues = audio.cues();
    const played: Record<string, number> = {};
    for (const cue of cues) played[cue.assetId] = (played[cue.assetId] ?? 0) + 1;
    return {
      running: true,
      sceneId: simulation.sceneId,
      state: {
        game,
        entities,
        events,
        hud: buildOrbRunHud(simulation),
        animation: orbRunAnimator(simulation).state(),
        audio: {
          initialized: audioState.initialized,
          buses: Object.fromEntries(audioState.buses.map((bus) => [bus.id, bus])),
          playbacks: audioState.activePlaybacks,
          playedCount: cues.length,
          played,
          cues,
          failedCount: audio.failures().length,
        },
        paused: this.#paused,
      },
    };
  }

  async logs(): Promise<RuntimeLog[]> {
    const current = this.#simulation ? this.#mapLogs(this.#simulation) : [];
    return [...this.#previousLogs, ...current];
  }

  async captureFrame(): Promise<Uint8Array> {
    throw new Error("The headless Orb Run probe has no renderer; frame and visual steps need the Electron player");
  }

  async metrics(): Promise<RuntimeMetrics> {
    const simulation = this.#simulation;
    if (!simulation) return {};
    const summary = summarizeOrbRun(simulation);
    return {
      "simulation.steps": simulation.step,
      "simulation.elapsedSeconds": simulation.elapsedSeconds,
      "game.elapsedSeconds": summary.elapsedSeconds,
      "game.remainingSeconds": summary.remainingSeconds,
      "game.collectedCount": summary.collectedCount,
    };
  }

  async captureSave(slotId = "default"): Promise<{ success: boolean; envelope?: Record<string, unknown>; error?: string }> {
    const simulation = this.#simulation;
    if (!simulation) return { success: false, error: "Runtime is not running" };
    const save = captureOrbRunSave(simulation);
    this.#slots.set(slotId, structuredClone(save));
    return { success: true, envelope: structuredClone(save) as unknown as Record<string, unknown> };
  }

  async getSave(slotId = "default"): Promise<{ success: boolean; envelope?: Record<string, unknown>; error?: string }> {
    const save = this.#slots.get(slotId);
    return save
      ? { success: true, envelope: structuredClone(save) as unknown as Record<string, unknown> }
      : { success: false, error: `No save in slot "${slotId}"` };
  }

  /**
   * Restores into a *fresh* simulation (like loading a save after a restart),
   * then swaps it in. A rejected save leaves the running simulation untouched.
   */
  async loadSave(params: { slotId?: string; envelope?: Record<string, unknown> }): Promise<{
    success: boolean;
    slotId?: string;
    schemaVersion?: number;
    error?: string;
  }> {
    const slotId = params.slotId ?? "default";
    const save = params.envelope
      ? (structuredClone(params.envelope) as unknown as OrbRunSaveData)
      : this.#slots.get(slotId);
    if (!save) return { success: false, error: `No save in slot "${slotId}"` };
    const fresh = await startOrbRunSimulation(this.#project, this.#animation);
    try {
      fresh.restoreStep(save.step);
      await restoreOrbRunSave(fresh, save);
    } catch (error) {
      await fresh.dispose();
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
    await this.stop();
    this.#simulation = fresh;
    return { success: true, slotId, schemaVersion: save.schemaVersion };
  }

  async close(): Promise<void> {
    await this.stop();
  }

  #require(): HeadlessSceneSimulation {
    if (!this.#simulation) throw new Error("Runtime is not running; add a runtime.start step first");
    return this.#simulation;
  }

  #stepsFor(milliseconds: number): number {
    const simulation = this.#require();
    if (!Number.isFinite(milliseconds) || milliseconds < 0) {
      throw new RangeError(`Duration must be finite and >= 0, got ${milliseconds}`);
    }
    const steps = Math.round(milliseconds / 1000 / simulation.fixedDeltaSeconds);
    if (steps > ORB_RUN_MAX_STEPS_PER_CALL) {
      throw new RangeError(
        `Duration ${milliseconds}ms is ${steps} fixed steps; the limit is ${ORB_RUN_MAX_STEPS_PER_CALL} per call`,
      );
    }
    if (steps === 0 && milliseconds > 0) {
      throw new RangeError(
        `Duration ${milliseconds}ms is shorter than half a fixed step (${simulation.fixedDeltaSeconds * 1000}ms) and would advance nothing`,
      );
    }
    return steps;
  }

  #advance(steps: number): void {
    const simulation = this.#require();
    if (this.#paused) return;
    simulation.advance(steps);
  }

  #mapLogs(simulation: HeadlessSceneSimulation): RuntimeLog[] {
    const logs: RuntimeLog[] = simulation.logs().map((entry) => ({
      level: entry.level,
      message: entry.category,
      data: { step: entry.step, ...(entry.data ?? {}) },
    }));
    const audio = orbRunAudio(simulation);
    for (const cue of audio.cues()) {
      logs.push({
        level: "info",
        message: "audio.played",
        data: { step: cue.step, assetId: cue.assetId, bus: cue.bus, playbackId: cue.playbackId },
      });
    }
    for (const failure of audio.failures()) {
      logs.push({ level: "warning", message: "audio.failed", data: { ...failure } });
    }
    for (const failure of orbRunAnimator(simulation).failures()) {
      logs.push({ level: "warning", message: "animation.failed", data: { ...failure } });
    }
    return logs;
  }
}
