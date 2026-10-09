import {
  AudioMixerModel,
  type AudioBusDefinition,
  type AudioBusState,
  type AudioPlaybackState,
  type AudioRuntimeState,
} from "@kinetra/audio";
import type { AssetResolver } from "@kinetra/renderer-three";

export interface PlayAudioOptions {
  assetId: string;
  bus?: string;
  loop?: boolean;
  gain?: number;
  entityId?: string;
}

export interface PlayAudioResult {
  success: boolean;
  playbackId?: string;
  error?: string;
}

export interface StopAudioOptions {
  playbackId?: string;
  entityId?: string;
}

export interface StopAudioResult {
  success: boolean;
  stoppedCount: number;
}

interface ActivePlaybackRecord {
  id: string;
  assetId: string;
  bus: string;
  loop: boolean;
  gain: number;
  entityId?: string | undefined;
  playing: boolean;
  sourceNode?: AudioBufferSourceNode | undefined;
  gainNode?: GainNode | undefined;
  startTime: number;
  duration?: number | undefined;
}

async function toArrayBuffer(raw: unknown): Promise<ArrayBuffer | undefined> {
  const resolved = raw instanceof Promise ? await raw : raw;
  if (!resolved) return undefined;
  if (resolved instanceof ArrayBuffer) {
    const copy = new Uint8Array(resolved.byteLength);
    copy.set(new Uint8Array(resolved));
    return copy.buffer;
  }
  if (resolved instanceof Uint8Array) {
    const copy = new Uint8Array(resolved.byteLength);
    copy.set(resolved);
    return copy.buffer;
  }
  if (typeof resolved === "string") {
    const binary = atob(resolved);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }
  return undefined;
}

/**
 * Finished/stopped playback records kept for inspection (`getState`). Older ones are dropped so a
 * long session of one-shot sound effects does not grow the map (and its state report) forever.
 */
export const MAX_FINISHED_PLAYBACK_RECORDS = 32;

export const DEFAULT_AUDIO_BUSES: AudioBusDefinition[] = [
  { id: "master", gain: 1.0 },
  { id: "music", parentId: "master", gain: 1.0 },
  { id: "sfx", parentId: "master", gain: 1.0 },
  { id: "voice", parentId: "master", gain: 1.0 },
];

export class PlayerAudioController {
  #context: AudioContext | undefined;
  #mixer: AudioMixerModel = new AudioMixerModel(DEFAULT_AUDIO_BUSES);
  #busNodes = new Map<string, GainNode>();
  #assetResolver: AssetResolver | undefined;
  #decodedBuffers = new Map<string, AudioBuffer>();
  #playbacks = new Map<string, ActivePlaybackRecord>();
  #nextPlaybackId = 0;
  #initialized = false;
  /** Bumped by `reset()`; an in-flight `play()` that sees a new value belongs to a dead scene. */
  #generation = 0;

  constructor() {
    this.#ensureContext();
  }

  #ensureContext(): AudioContext | undefined {
    if (!this.#context && typeof window !== "undefined") {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (AudioCtx) {
        this.#context = new AudioCtx();
      }
    }
    if (this.#context && this.#context.state === "suspended") {
      void this.#context.resume();
    }
    return this.#context;
  }

  init(resolver: AssetResolver, buses?: AudioBusDefinition[]): void {
    this.reset();
    this.#assetResolver = resolver;
    const busDefinitions = buses ?? DEFAULT_AUDIO_BUSES;
    this.#mixer = new AudioMixerModel(busDefinitions);
    this.#rebuildBusGraph(busDefinitions);
    this.#initialized = true;
  }

  #rebuildBusGraph(busDefinitions: AudioBusDefinition[]): void {
    const ctx = this.#ensureContext();
    if (!ctx) return;

    // Disconnect and clear existing bus nodes
    for (const node of this.#busNodes.values()) {
      try {
        node.disconnect();
      } catch {
        // ignore
      }
    }
    this.#busNodes.clear();

    // Create a GainNode for each bus
    for (const bus of busDefinitions) {
      const node = ctx.createGain();
      node.gain.value = bus.muted ? 0 : bus.gain;
      this.#busNodes.set(bus.id, node);
    }

    // Connect child buses to parent buses, or root buses to destination
    for (const bus of busDefinitions) {
      const childNode = this.#busNodes.get(bus.id);
      if (!childNode) continue;

      if (bus.parentId) {
        const parentNode = this.#busNodes.get(bus.parentId);
        if (parentNode) {
          childNode.connect(parentNode);
        } else {
          childNode.connect(ctx.destination);
        }
      } else {
        childNode.connect(ctx.destination);
      }
    }
  }

  hasBus(busId: string): boolean {
    return this.#mixer.hasBus(busId);
  }

  setBusGain(busId: string, gain: number): void {
    if (!this.#mixer.hasBus(busId)) {
      throw new Error(`Unknown audio bus "${busId}"`);
    }
    this.#mixer.setGain(busId, gain);
    const busDef = this.#mixer.getBus(busId);
    const node = this.#busNodes.get(busId);
    if (node && busDef) {
      node.gain.value = busDef.muted ? 0 : gain;
    }
  }

  setBusMuted(busId: string, muted: boolean): void {
    if (!this.#mixer.hasBus(busId)) {
      throw new Error(`Unknown audio bus "${busId}"`);
    }
    this.#mixer.setMuted(busId, muted);
    const busDef = this.#mixer.getBus(busId);
    const node = this.#busNodes.get(busId);
    if (node && busDef) {
      node.gain.value = muted ? 0 : busDef.gain;
    }
  }

  async play(options: PlayAudioOptions): Promise<PlayAudioResult> {
    const busId = options.bus ?? "master";
    const generation = this.#generation;
    if (!this.#mixer.hasBus(busId)) {
      return {
        success: false,
        error: `Unknown audio bus "${busId}"`,
      };
    }

    if (!this.#assetResolver) {
      return {
        success: false,
        error: "Audio controller is not initialized with an asset resolver",
      };
    }

    const ctx = this.#ensureContext();
    if (!ctx) {
      return {
        success: false,
        error: "Web Audio AudioContext is unavailable in this environment",
      };
    }

    let audioBuffer = this.#decodedBuffers.get(options.assetId);
    if (!audioBuffer) {
      const rawAsset = this.#assetResolver.resolve(options.assetId);
      const arrayBuffer = await toArrayBuffer(rawAsset);
      if (generation !== this.#generation) return this.#resetWhileLoading(options.assetId);
      if (!arrayBuffer) {
        return {
          success: false,
          error: `Audio asset "${options.assetId}" not found`,
        };
      }

      try {
        audioBuffer = await ctx.decodeAudioData(arrayBuffer);
      } catch (decodeErr) {
        if (generation !== this.#generation) return this.#resetWhileLoading(options.assetId);
        const message =
          decodeErr instanceof Error ? decodeErr.message : String(decodeErr);
        return {
          success: false,
          error: `Failed to decode audio asset "${options.assetId}": ${message}`,
        };
      }
      // The buffer was decoded from the previous scene's resolver: caching it would serve the
      // wrong audio for the same asset id after a re-init.
      if (generation !== this.#generation) return this.#resetWhileLoading(options.assetId);
      this.#decodedBuffers.set(options.assetId, audioBuffer);
    }

    const playbackId = `playback_${++this.#nextPlaybackId}`;
    const instanceGain =
      typeof options.gain === "number" && Number.isFinite(options.gain)
        ? Math.max(0, options.gain)
        : 1.0;
    const loop = Boolean(options.loop);

    const sourceNode = ctx.createBufferSource();
    sourceNode.buffer = audioBuffer;
    sourceNode.loop = loop;

    const gainNode = ctx.createGain();
    gainNode.gain.value = instanceGain;

    const busNode = this.#busNodes.get(busId);
    sourceNode.connect(gainNode);
    if (busNode) {
      gainNode.connect(busNode);
    } else {
      gainNode.connect(ctx.destination);
    }

    const record: ActivePlaybackRecord = {
      id: playbackId,
      assetId: options.assetId,
      bus: busId,
      loop,
      gain: instanceGain,
      entityId: options.entityId,
      playing: true,
      sourceNode,
      gainNode,
      startTime: ctx.currentTime,
      duration: audioBuffer.duration,
    };

    sourceNode.onended = () => {
      if (record.playing) {
        this.#retire(record);
      }
    };

    try {
      sourceNode.start();
    } catch (startErr) {
      this.#release(record);
      const message =
        startErr instanceof Error ? startErr.message : String(startErr);
      return {
        success: false,
        error: `Failed to start audio playback "${playbackId}": ${message}`,
      };
    }

    this.#playbacks.set(playbackId, record);
    this.#pruneFinished();

    return {
      success: true,
      playbackId,
    };
  }

  stop(options: StopAudioOptions = {}): StopAudioResult {
    let stoppedCount = 0;

    for (const record of this.#playbacks.values()) {
      if (!record.playing) continue;

      const matchesPlayback =
        options.playbackId === undefined || record.id === options.playbackId;
      const matchesEntity =
        options.entityId === undefined || record.entityId === options.entityId;

      if (matchesPlayback && matchesEntity) {
        this.#retire(record, true);
        stoppedCount++;
      }
    }

    return {
      success: true,
      stoppedCount,
    };
  }

  #resetWhileLoading(assetId: string): PlayAudioResult {
    return {
      success: false,
      error: `Audio controller was reset while loading "${assetId}"`,
    };
  }

  /** Marks a playback finished, frees its Web Audio nodes and trims old finished records. */
  #retire(record: ActivePlaybackRecord, stopSource = false): void {
    record.playing = false;
    if (stopSource && record.sourceNode) {
      try {
        record.sourceNode.stop();
      } catch {
        // ignore
      }
    }
    this.#release(record);
    this.#pruneFinished();
  }

  #release(record: ActivePlaybackRecord): void {
    for (const node of [record.sourceNode, record.gainNode]) {
      try {
        node?.disconnect();
      } catch {
        // ignore
      }
    }
    record.sourceNode = undefined;
    record.gainNode = undefined;
  }

  #pruneFinished(): void {
    let finished = 0;
    for (const record of this.#playbacks.values()) if (!record.playing) finished++;
    if (finished <= MAX_FINISHED_PLAYBACK_RECORDS) return;
    // Map iteration is insertion order, so the oldest finished records go first.
    for (const [id, record] of this.#playbacks) {
      if (finished <= MAX_FINISHED_PLAYBACK_RECORDS) break;
      if (!record.playing) {
        this.#playbacks.delete(id);
        finished--;
      }
    }
  }

  getState(): AudioRuntimeState {
    const busStates: AudioBusState[] = this.#mixer.getAllBusStates();
    const playbacks: AudioPlaybackState[] = [];

    const now = this.#context?.currentTime ?? 0;

    for (const record of this.#playbacks.values()) {
      const busEffective = this.#mixer.effectiveGain(record.bus);
      const effectiveGain = record.gain * busEffective;
      const isMuted = busEffective === 0;

      let currentTime = 0;
      if (record.playing && record.duration) {
        const elapsed = Math.max(0, now - record.startTime);
        currentTime = record.loop ? elapsed % record.duration : Math.min(elapsed, record.duration);
      }

      playbacks.push({
        playbackId: record.id,
        ...(record.entityId ? { entityId: record.entityId } : {}),
        assetId: record.assetId,
        bus: record.bus,
        playing: record.playing,
        loop: record.loop,
        gain: record.gain,
        effectiveGain,
        muted: isMuted,
        ...(record.duration !== undefined ? { duration: record.duration } : {}),
        currentTime,
      });
    }

    return {
      initialized: this.#initialized,
      buses: busStates,
      activePlaybacks: playbacks,
    };
  }

  reset(): void {
    this.#generation++;
    // Stop and disconnect all playbacks
    for (const record of this.#playbacks.values()) {
      if (record.playing) {
        record.playing = false;
        if (record.sourceNode) {
          try {
            record.sourceNode.stop();
            record.sourceNode.disconnect();
          } catch {
            // ignore
          }
        }
        if (record.gainNode) {
          try {
            record.gainNode.disconnect();
          } catch {
            // ignore
          }
        }
      }
    }
    this.#playbacks.clear();
    this.#decodedBuffers.clear();

    // Disconnect bus nodes
    for (const node of this.#busNodes.values()) {
      try {
        node.disconnect();
      } catch {
        // ignore
      }
    }
    this.#busNodes.clear();

    this.#mixer = new AudioMixerModel(DEFAULT_AUDIO_BUSES);
    this.#initialized = false;
  }
}
