import {
  AudioMixerModel,
  createSyntheticWav,
  type AudioPlaybackState,
  type AudioRuntimeState,
} from "@kinetra/audio";
import type { GameScriptAudioService } from "@kinetra/core";

/**
 * Orb Run audio: asset ids, bus layout, deterministic synthetic clips, and a
 * headless `GameScriptAudioService` that proves *which cues played, on which
 * bus, at what effective gain* without a Web Audio device.
 *
 * Kinetra's real audio controller (apps/player) is bound to Web Audio, so there
 * is no engine headless audio service yet. `HeadlessAudioService` here is the
 * stop-gap (see "Engine requests" in README.md). The mixer itself is the
 * engine's own `AudioMixerModel`, so gain/mute maths is the real contract.
 */

export const ORB_RUN_AUDIO_BUS = {
  master: "master",
  music: "music",
  sfx: "sfx",
} as const;

/** Pickup pitch ladder: each orb collected plays a higher note (C5, E5, G5). */
export const ORB_RUN_PICKUP_ASSET_IDS = [
  "asset_orbrun_sfx_pickup_1",
  "asset_orbrun_sfx_pickup_2",
  "asset_orbrun_sfx_pickup_3",
] as const;

export const ORB_RUN_AUDIO_ASSET = {
  pickups: ORB_RUN_PICKUP_ASSET_IDS,
  exitUnlocked: "asset_orbrun_sfx_exit_unlocked",
  win: "asset_orbrun_sfx_win",
  lose: "asset_orbrun_sfx_lose",
} as const;

const SAMPLE_RATE = 22050;

interface ClipSpec {
  frequency: number;
  durationSeconds: number;
}

const CLIP_SPECS: Record<string, ClipSpec> = {
  [ORB_RUN_PICKUP_ASSET_IDS[0]]: { frequency: 523.25, durationSeconds: 0.12 },
  [ORB_RUN_PICKUP_ASSET_IDS[1]]: { frequency: 659.25, durationSeconds: 0.12 },
  [ORB_RUN_PICKUP_ASSET_IDS[2]]: { frequency: 783.99, durationSeconds: 0.12 },
  [ORB_RUN_AUDIO_ASSET.exitUnlocked]: { frequency: 987.77, durationSeconds: 0.4 },
  [ORB_RUN_AUDIO_ASSET.win]: { frequency: 1046.5, durationSeconds: 0.6 },
  [ORB_RUN_AUDIO_ASSET.lose]: { frequency: 130.81, durationSeconds: 0.5 },
};

/** Every Orb Run audio asset id, sorted (stable for manifests and tests). */
export const ORB_RUN_AUDIO_ASSET_IDS: readonly string[] = Object.keys(CLIP_SPECS).sort();

/** Deterministic WAV bytes per asset id; generated from code, no binary files in the repo. */
export function createOrbRunAudioBytes(): Record<string, Uint8Array> {
  const bytes: Record<string, Uint8Array> = {};
  for (const assetId of ORB_RUN_AUDIO_ASSET_IDS) {
    const spec = CLIP_SPECS[assetId]!;
    bytes[assetId] = createSyntheticWav({ ...spec, sampleRate: SAMPLE_RATE });
  }
  return bytes;
}

/** Duration in seconds of a clip, read from its authored spec. */
export function orbRunClipDuration(assetId: string): number | undefined {
  return CLIP_SPECS[assetId]?.durationSeconds;
}

/** Pickup clip for the Nth orb (1-based); beyond the ladder it stays on the top note. */
export function pickupAssetForCount(collectedCount: number): string {
  if (!Number.isInteger(collectedCount) || collectedCount < 1) {
    throw new RangeError(`collectedCount must be an integer >= 1, got ${String(collectedCount)}`);
  }
  return ORB_RUN_PICKUP_ASSET_IDS[Math.min(collectedCount, ORB_RUN_PICKUP_ASSET_IDS.length) - 1]!;
}

/** master -> {music, sfx}. Music is authored quieter than sfx so cues stay audible. */
export function createOrbRunMixer(): AudioMixerModel {
  return new AudioMixerModel([
    { id: ORB_RUN_AUDIO_BUS.master, gain: 1 },
    { id: ORB_RUN_AUDIO_BUS.music, parentId: ORB_RUN_AUDIO_BUS.master, gain: 0.4 },
    { id: ORB_RUN_AUDIO_BUS.sfx, parentId: ORB_RUN_AUDIO_BUS.master, gain: 0.9 },
  ]);
}

export interface PlayedCue {
  playbackId: string;
  assetId: string;
  bus: string;
  gain: number;
  /** Simulation step when the cue started. */
  step: number;
  /** Instance gain times the bus chain's gain at the moment it started (0 when muted). */
  effectiveGainAtStart: number;
}

export interface HeadlessAudioOptions {
  /** Simulation clock in seconds; playback progress and "still playing" derive from it. */
  now: () => number;
  /** Current simulation step, recorded on every cue. */
  step: () => number;
  mixer?: AudioMixerModel;
  assetIds?: readonly string[];
}

interface PlaybackRecord {
  playbackId: string;
  assetId: string;
  bus: string;
  loop: boolean;
  gain: number;
  entityId: string | undefined;
  startSeconds: number;
  duration: number;
  stopped: boolean;
}

export class HeadlessAudioService implements GameScriptAudioService {
  readonly mixer: AudioMixerModel;
  readonly #options: HeadlessAudioOptions;
  readonly #assets: ReadonlySet<string>;
  readonly #records: PlaybackRecord[] = [];
  readonly #cues: PlayedCue[] = [];
  readonly #failures: Array<{ assetId: string; bus: string; error: string }> = [];
  #nextId = 0;

  constructor(options: HeadlessAudioOptions) {
    this.#options = options;
    this.mixer = options.mixer ?? createOrbRunMixer();
    this.#assets = new Set(options.assetIds ?? ORB_RUN_AUDIO_ASSET_IDS);
  }

  async play(options: {
    assetId: string;
    bus?: string;
    loop?: boolean;
    gain?: number;
    entityId?: string;
  }): Promise<{ success: boolean; playbackId?: string; error?: string }> {
    const bus = options.bus ?? ORB_RUN_AUDIO_BUS.master;
    const fail = (error: string) => {
      this.#failures.push({ assetId: options.assetId, bus, error });
      return { success: false, error };
    };
    if (!this.mixer.hasBus(bus)) return fail(`Unknown audio bus "${bus}"`);
    if (!this.#assets.has(options.assetId)) return fail(`Audio asset "${options.assetId}" not found`);
    // Same coercion as the Web Audio controller: bad instance gain falls back to 1, negative clamps to 0.
    const gain =
      typeof options.gain === "number" && Number.isFinite(options.gain) ? Math.max(0, options.gain) : 1;
    this.#nextId += 1;
    const playbackId = `playback_${this.#nextId}`;
    const record: PlaybackRecord = {
      playbackId,
      assetId: options.assetId,
      bus,
      loop: Boolean(options.loop),
      gain,
      entityId: options.entityId,
      startSeconds: this.#options.now(),
      duration: orbRunClipDuration(options.assetId) ?? 0,
      stopped: false,
    };
    this.#records.push(record);
    this.#cues.push({
      playbackId,
      assetId: options.assetId,
      bus,
      gain,
      step: this.#options.step(),
      effectiveGainAtStart: gain * this.mixer.effectiveGain(bus),
    });
    return { success: true, playbackId };
  }

  stop(options: { playbackId?: string; entityId?: string } = {}): { success: true; stoppedCount: number } {
    let stoppedCount = 0;
    for (const record of this.#records) {
      if (record.stopped || !this.#isPlaying(record)) continue;
      if (options.playbackId !== undefined && record.playbackId !== options.playbackId) continue;
      if (options.entityId !== undefined && record.entityId !== options.entityId) continue;
      record.stopped = true;
      stoppedCount += 1;
    }
    return { success: true, stoppedCount };
  }

  setBusGain(busId: string, gain: number): void {
    this.mixer.setGain(busId, gain);
  }

  setBusMuted(busId: string, muted: boolean): void {
    this.mixer.setMuted(busId, muted);
  }

  /** Every cue ever started, in order (copy). */
  cues(assetId?: string): PlayedCue[] {
    const cues = assetId ? this.#cues.filter((cue) => cue.assetId === assetId) : this.#cues;
    return structuredClone(cues);
  }

  /** Plays that were refused (unknown bus/asset). A healthy run has none. */
  failures(): Array<{ assetId: string; bus: string; error: string }> {
    return structuredClone(this.#failures);
  }

  /** Same shape as the engine's `AudioRuntimeState`, with times on the simulation clock. */
  state(): AudioRuntimeState {
    const now = this.#options.now();
    const activePlaybacks: AudioPlaybackState[] = this.#records.map((record) => {
      const busGain = this.mixer.effectiveGain(record.bus);
      const playing = this.#isPlaying(record);
      const elapsed = Math.max(0, now - record.startSeconds);
      const currentTime = !playing
        ? 0
        : record.loop && record.duration > 0
          ? elapsed % record.duration
          : Math.min(elapsed, record.duration);
      return {
        playbackId: record.playbackId,
        ...(record.entityId ? { entityId: record.entityId } : {}),
        assetId: record.assetId,
        bus: record.bus,
        playing,
        loop: record.loop,
        gain: record.gain,
        effectiveGain: record.gain * busGain,
        muted: busGain === 0,
        duration: record.duration,
        currentTime,
      };
    });
    return { initialized: true, buses: this.mixer.getAllBusStates(), activePlaybacks };
  }

  #isPlaying(record: PlaybackRecord): boolean {
    if (record.stopped) return false;
    if (record.loop) return true;
    // Float-safe: a clip that is exactly `duration` seconds old has ended.
    return this.#options.now() - record.startSeconds < record.duration - 1e-9;
  }
}
