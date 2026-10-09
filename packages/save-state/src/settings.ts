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

/**
 * Keeps only `action -> unknown[]` entries from an untrusted settings document.
 * Returns undefined when nothing usable remains, so `input` is omitted.
 */
function sanitizeCustomBindings(value: unknown): Record<string, unknown[]> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const result: Record<string, unknown[]> = {};
  let kept = 0;
  for (const [action, bindings] of Object.entries(value)) {
    if (Array.isArray(bindings)) {
      // defineProperty keeps a "__proto__" action as plain data instead of a prototype swap.
      Object.defineProperty(result, action, {
        value: structuredClone(bindings),
        enumerable: true,
        writable: true,
        configurable: true,
      });
      kept += 1;
    }
  }
  return kept > 0 ? result : undefined;
}

export class SettingsStore {
  readonly #docStore: JsonDocumentStore<PlayerSettingsData>;

  constructor(storage: KeyValueStorage) {
    this.#docStore = new JsonDocumentStore<PlayerSettingsData>(storage, "settings");
  }

  async load(key = "user-settings"): Promise<PlayerSettingsData> {
    let data: PlayerSettingsData | undefined;
    try {
      data = await this.#docStore.load(key);
    } catch (error) {
      // A truncated/corrupt settings file (crash mid-write, full disk) must not block
      // player start-up; the next save overwrites it. Storage I/O errors still propagate.
      if (error instanceof SyntaxError) {
        return structuredClone(DEFAULT_PLAYER_SETTINGS);
      }
      throw error;
    }
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      return structuredClone(DEFAULT_PLAYER_SETTINGS);
    }
    const base: PlayerSettingsData = {
      schemaVersion: 1,
      audio: {
        masterGain: typeof data.audio?.masterGain === "number" ? Math.max(0, Math.min(1, data.audio.masterGain)) : 1.0,
        sfxGain: typeof data.audio?.sfxGain === "number" ? Math.max(0, Math.min(1, data.audio.sfxGain)) : 1.0,
      },
      display: {
        fullscreen: Boolean(data.display?.fullscreen),
      },
    };
    const customBindings = sanitizeCustomBindings(data.input?.customBindings);
    return {
      ...base,
      ...(customBindings ? { input: { customBindings } } : {}),
    };
  }

  async save(settings: PlayerSettingsData, key = "user-settings"): Promise<void> {
    await this.#docStore.save(key, settings);
  }

  async remove(key = "user-settings"): Promise<void> {
    await this.#docStore.remove(key);
  }
}
