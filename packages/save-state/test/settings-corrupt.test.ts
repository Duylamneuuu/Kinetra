import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_PLAYER_SETTINGS,
  MemoryStorage,
  SettingsStore,
} from "../src/index.js";

// A settings file that was truncated by a crash / full disk must not stop the
// player shell from starting: GameShellController.init() awaits SettingsStore.load().
for (const [label, raw] of [
  ["truncated JSON", '{"schemaVersion":1,"audio":{"masterGain":0.'],
  ["empty file", ""],
  ["garbage", "not json at all"],
] as const) {
  test(`SettingsStore.load falls back to defaults on ${label}`, async () => {
    const memory = new MemoryStorage();
    await memory.set("settings:user-settings", raw);
    const store = new SettingsStore(memory);
    assert.deepEqual(await store.load(), DEFAULT_PLAYER_SETTINGS);
  });
}

test("SettingsStore.load falls back to defaults when the document is not an object", async () => {
  for (const raw of ["42", '"text"', "[1,2,3]", "true"]) {
    const memory = new MemoryStorage();
    await memory.set("settings:user-settings", raw);
    assert.deepEqual(await new SettingsStore(memory).load(), DEFAULT_PLAYER_SETTINGS, raw);
  }
});

test("SettingsStore.load still surfaces storage I/O failures", async () => {
  const failing = {
    async get(): Promise<string | undefined> {
      throw new Error("disk unavailable");
    },
    async set(): Promise<void> {},
    async delete(): Promise<void> {},
  };
  await assert.rejects(new SettingsStore(failing).load(), /disk unavailable/);
});

test("a corrupt settings document is replaced by the next save", async () => {
  const memory = new MemoryStorage();
  await memory.set("settings:user-settings", "{broken");
  const store = new SettingsStore(memory);
  const loaded = await store.load();
  await store.save({ ...loaded, audio: { masterGain: 0.5, sfxGain: 0.25 } });
  assert.equal((await store.load()).audio.masterGain, 0.5);
});
