import {
  JsonDocumentStore,
  type KeyValueStorage,
} from "./index.js";

export interface PlayerSettingsData {
  schemaVersion: 1;
  audio: {
    masterGain: number; // 0.0 - 1.0
    sfxGain: number;    // 0.0 - 1.0
  };
  display: {
    fullscreen: boolean;
  };
  input?: {
    customBindings?: Record<string, unknown[]>;
  };
}

export const DEFAULT_PLAYER_SETTINGS: PlayerSettingsData = {
  schemaVersion: 1,
  audio: {
    masterGain: 1.0,
    sfxGain: 1.0,
  },
  display: {
    fullscreen: false,
  },
};

export class SettingsStore {
  readonly #docStore: JsonDocumentStore<PlayerSettingsData>;

  constructor(storage: KeyValueStorage) {
    this.#docStore = new JsonDocumentStore<PlayerSettingsData>(storage, "settings");
  }

  async load(key = "user-settings"): Promise<PlayerSettingsData> {
    const data = await this.#docStore.load(key);
    if (!data) {
      return structuredClone(DEFAULT_PLAYER_SETTINGS);
    }
    return {
      schemaVersion: 1,
      audio: {
        masterGain: typeof data.audio?.masterGain === "number" ? Math.max(0, Math.min(1, data.audio.masterGain)) : 1.0,
        sfxGain: typeof data.audio?.sfxGain === "number" ? Math.max(0, Math.min(1, data.audio.sfxGain)) : 1.0,
      },
      display: {
        fullscreen: Boolean(data.display?.fullscreen),
      },
      ...(data.input?.customBindings ? { input: { customBindings: structuredClone(data.input.customBindings) } } : {}),
    };
  }

  async save(settings: PlayerSettingsData, key = "user-settings"): Promise<void> {
    await this.#docStore.save(key, settings);
  }

  async remove(key = "user-settings"): Promise<void> {
    await this.#docStore.remove(key);
  }
}
