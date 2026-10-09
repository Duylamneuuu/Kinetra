import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_PLAYER_SETTINGS, MemoryStorage, SettingsStore } from "../src/index.js";

// JSON.stringify turns NaN/Infinity into null, and load() then falls back to the default gain of 1.0:
// a player who muted the game (or whose slider produced NaN) would get full volume back on restart.
test("SettingsStore.save rejects non-finite gains instead of persisting null", async () => {
  const storage = new MemoryStorage();
  const store = new SettingsStore(storage);
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const settings = structuredClone(DEFAULT_PLAYER_SETTINGS);
    settings.audio.masterGain = bad;
    await assert.rejects(() => store.save(settings), /masterGain/);
    const sfx = structuredClone(DEFAULT_PLAYER_SETTINGS);
    sfx.audio.sfxGain = bad;
    await assert.rejects(() => store.save(sfx), /sfxGain/);
  }
  assert.equal(await storage.get("settings:user-settings"), undefined);
});

test("SettingsStore.save still accepts valid settings and out-of-range finite gains (clamped on load)", async () => {
  const store = new SettingsStore(new MemoryStorage());
  const settings = structuredClone(DEFAULT_PLAYER_SETTINGS);
  settings.audio.masterGain = 0;
  await store.save(settings);
  assert.equal((await store.load()).audio.masterGain, 0);
  settings.audio.masterGain = 5;
  await store.save(settings);
  assert.equal((await store.load()).audio.masterGain, 1);
});
