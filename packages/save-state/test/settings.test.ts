import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEFAULT_PLAYER_SETTINGS,
  MemoryStorage,
  SettingsStore,
  type PlayerSettingsData,
} from "../src/index.js";
import { FileKeyValueStorage } from "../src/file-storage.js";

test("SettingsStore returns defaults when no settings saved", async () => {
  const memory = new MemoryStorage();
  const store = new SettingsStore(memory);

  const settings = await store.load();
  assert.deepEqual(settings, DEFAULT_PLAYER_SETTINGS);
});

test("SettingsStore persists and loads modified audio and display settings", async () => {
  const memory = new MemoryStorage();
  const store = new SettingsStore(memory);

  const customSettings: PlayerSettingsData = {
    schemaVersion: 1,
    audio: {
      masterGain: 0.6,
      sfxGain: 0.35,
    },
    display: {
      fullscreen: true,
    },
    input: {
      customBindings: {
        "player.moveRight": [{ kind: "key", code: "KeyL", scale: 1 }],
      },
    },
  };

  await store.save(customSettings);

  const loaded = await store.load();
  assert.equal(loaded.audio.masterGain, 0.6);
  assert.equal(loaded.audio.sfxGain, 0.35);
  assert.equal(loaded.display.fullscreen, true);
  assert.deepEqual(loaded.input?.customBindings, customSettings.input?.customBindings);
});

test("SettingsStore clamps gain values to [0, 1]", async () => {
  const memory = new MemoryStorage();
  const store = new SettingsStore(memory);

  await store.save({
    schemaVersion: 1,
    audio: {
      masterGain: 1.5,
      sfxGain: -0.2,
    },
    display: {
      fullscreen: false,
    },
  });

  const loaded = await store.load();
  assert.equal(loaded.audio.masterGain, 1.0);
  assert.equal(loaded.audio.sfxGain, 0.0);
});

test("SettingsStore works with FileKeyValueStorage in isolated temp directory", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "kinetra-settings-test-"));
  try {
    const fileStorage = new FileKeyValueStorage(tempDir);
    const store = new SettingsStore(fileStorage);

    const custom: PlayerSettingsData = {
      schemaVersion: 1,
      audio: {
        masterGain: 0.45,
        sfxGain: 0.8,
      },
      display: {
        fullscreen: true,
      },
    };

    await store.save(custom);

    // Verify fresh store instance over the same filesystem root
    const store2 = new SettingsStore(new FileKeyValueStorage(tempDir));
    const loaded = await store2.load();
    assert.equal(loaded.audio.masterGain, 0.45);
    assert.equal(loaded.audio.sfxGain, 0.8);
    assert.equal(loaded.display.fullscreen, true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
