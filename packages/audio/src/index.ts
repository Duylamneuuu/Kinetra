export interface AudioBusDefinition {
  id: string;
  parentId?: string | undefined;
  gain: number;
  muted?: boolean | undefined;
}

export interface AudioBusState {
  id: string;
  parentId?: string | undefined;
  gain: number;
  effectiveGain: number;
  muted: boolean;
}

export interface AudioPlaybackState {
  playbackId: string;
  entityId?: string | undefined;
  assetId: string;
  bus: string;
  playing: boolean;
  loop: boolean;
  gain: number;
  effectiveGain: number;
  muted: boolean;
  duration?: number | undefined;
  currentTime?: number | undefined;
  error?: string | undefined;
}

export interface AudioRuntimeState {
  initialized: boolean;
  buses: AudioBusState[];
  activePlaybacks: AudioPlaybackState[];
}

export class AudioMixerModel {
  #buses = new Map<string, AudioBusDefinition>();

  constructor(buses: AudioBusDefinition[]) {
    for (const bus of buses) {
      if (this.#buses.has(bus.id)) throw new Error(`Duplicate audio bus "${bus.id}"`);
      this.#buses.set(bus.id, structuredClone(bus));
    }
    for (const bus of this.#buses.values()) {
      if (bus.parentId && !this.#buses.has(bus.parentId)) throw new Error(`Audio bus parent "${bus.parentId}" missing`);
    }
    for (const id of this.#buses.keys()) this.#assertNoCycle(id);
  }

  hasBus(id: string): boolean {
    return this.#buses.has(id);
  }

  getBus(id: string): AudioBusDefinition | undefined {
    const bus = this.#buses.get(id);
    return bus ? structuredClone(bus) : undefined;
  }

  getBuses(): readonly AudioBusDefinition[] {
    return Array.from(this.#buses.values()).map((bus) => structuredClone(bus));
  }

  getBusState(id: string): AudioBusState | undefined {
    const bus = this.#buses.get(id);
    if (!bus) return undefined;
    return {
      id: bus.id,
      parentId: bus.parentId,
      gain: bus.gain,
      effectiveGain: this.effectiveGain(bus.id),
      muted: Boolean(bus.muted),
    };
  }

  getAllBusStates(): AudioBusState[] {
    return Array.from(this.#buses.keys()).map((id) => this.getBusState(id)!);
  }

  setGain(id: string, gain: number): void {
    if (!Number.isFinite(gain) || gain < 0) throw new RangeError("gain must be finite and >= 0");
    this.#require(id).gain = gain;
  }

  setMuted(id: string, muted: boolean): void {
    this.#require(id).muted = muted;
  }

  effectiveGain(id: string): number {
    let gain = 1;
    let current: AudioBusDefinition | undefined = this.#require(id);
    const visited = new Set<string>();

    while (current) {
      if (visited.has(current.id)) throw new Error("Audio bus cycle detected");
      visited.add(current.id);
      if (current.muted) return 0;
      gain *= current.gain;
      current = current.parentId ? this.#buses.get(current.parentId) : undefined;
    }
    return gain;
  }

  #require(id: string): AudioBusDefinition {
    const bus = this.#buses.get(id);
    if (!bus) throw new Error(`Unknown audio bus "${id}"`);
    return bus;
  }

  #assertNoCycle(id: string): void {
    const visited = new Set<string>();
    let current: AudioBusDefinition | undefined = this.#buses.get(id);
    while (current) {
      if (visited.has(current.id)) throw new Error("Audio bus cycle detected");
      visited.add(current.id);
      current = current.parentId ? this.#buses.get(current.parentId) : undefined;
    }
  }
}

export interface SyntheticWavOptions {
  sampleRate?: number;
  durationSeconds?: number;
  frequency?: number;
}

export function createSyntheticWav(options: SyntheticWavOptions = {}): Uint8Array {
  const sampleRate = options.sampleRate ?? 44100;
  const durationSeconds = options.durationSeconds ?? 0.25;
  const frequency = options.frequency ?? 440;

  const numChannels = 1;
  const bitsPerSample = 16;
  const numSamples = Math.floor(sampleRate * durationSeconds);
  const bytesPerSample = bitsPerSample / 8;
  const subChunk2Size = numSamples * numChannels * bytesPerSample;
  const buffer = new ArrayBuffer(44 + subChunk2Size);
  const view = new DataView(buffer);

  // RIFF header
  view.setUint8(0, 0x52); // 'R'
  view.setUint8(1, 0x49); // 'I'
  view.setUint8(2, 0x46); // 'F'
  view.setUint8(3, 0x46); // 'F'
  view.setUint32(4, 36 + subChunk2Size, true); // chunkSize
  view.setUint8(8, 0x57);  // 'W'
  view.setUint8(9, 0x41);  // 'A'
  view.setUint8(10, 0x56); // 'V'
  view.setUint8(11, 0x45); // 'E'

  // fmt subchunk
  view.setUint8(12, 0x66); // 'f'
  view.setUint8(13, 0x6d); // 'm'
  view.setUint8(14, 0x74); // 't'
  view.setUint8(15, 0x20); // ' '
  view.setUint32(16, 16, true); // Subchunk1Size (16 for PCM)
  view.setUint16(20, 1, true);  // AudioFormat (1 = PCM)
  view.setUint16(22, numChannels, true); // NumChannels
  view.setUint32(24, sampleRate, true);  // SampleRate
  view.setUint32(28, sampleRate * numChannels * bytesPerSample, true); // ByteRate
  view.setUint16(32, numChannels * bytesPerSample, true); // BlockAlign
  view.setUint16(34, bitsPerSample, true); // BitsPerSample

  // data subchunk
  view.setUint8(36, 0x64); // 'd'
  view.setUint8(37, 0x61); // 'a'
  view.setUint8(38, 0x74); // 't'
  view.setUint8(39, 0x61); // 'a'
  view.setUint32(40, subChunk2Size, true);

  // PCM data: mono sine wave
  const amplitude = 0.8 * 32767;
  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const sample = Math.round(amplitude * Math.sin(2 * Math.PI * frequency * t));
    view.setInt16(offset, Math.max(-32768, Math.min(32767, sample)), true);
    offset += 2;
  }

  return new Uint8Array(buffer);
}
