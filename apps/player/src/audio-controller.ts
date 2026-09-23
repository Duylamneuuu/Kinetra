import {
  AudioMixerModel,
  describeUnknownPlayback,
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
  error?: string;
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
      if (!arrayBuffer) {
        return {
          success: false,
          error: `Audio asset "${options.assetId}" not found`,
        };
      }

      try {
        audioBuffer = await ctx.decodeAudioData(arrayBuffer);
        this.#decodedBuffers.set(options.assetId, audioBuffer);
      } catch (decodeErr) {
        const message =
          decodeErr instanceof Error ? decodeErr.message : String(decodeErr);
        return {
          success: false,
          error: `Failed to decode audio asset "${options.assetId}": ${message}`,
        };
      }
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
        record.playing = false;
        try {
          sourceNode.disconnect();
          gainNode.disconnect();
        } catch {
          // ignore
        }
      }
    };

    try {
      sourceNode.start();
    } catch (startErr) {
      const message =
        startErr instanceof Error ? startErr.message : String(startErr);
      return {
        success: false,
        error: `Failed to start audio playback "${playbackId}": ${message}`,
      };
    }

    this.#playbacks.set(playbackId, record);

    return {
      success: true,
      playbackId,
    };
  }

  stop(options: StopAudioOptions = {}): StopAudioResult {
    if (
      options.playbackId !== undefined &&
      !this.#playbacks.has(options.playbackId)
    ) {
      const activeIds = [...this.#playbacks.values()]
        .filter((record) => record.playing)
        .map((record) => record.id);
      return {
        success: false,
        stoppedCount: 0,
        error: describeUnknownPlayback(options.playbackId, activeIds),
      };
    }

    let stoppedCount = 0;

    for (const record of this.#playbacks.values()) {
      if (!record.playing) continue;

      const matchesPlayback =
        options.playbackId === undefined || record.id === options.playbackId;
      const matchesEntity =
        options.entityId === undefined || record.entityId === options.entityId;

      if (matchesPlayback && matchesEntity) {
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
        stoppedCount++;
      }
    }

    return {
      success: true,
      stoppedCount,
    };
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
