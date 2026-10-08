import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import test from "node:test";

import {
  MemoryStorage,
  SaveMigrator,
  SettingsStore,
  createGameplaySaveMigrator,
  type SaveEnvelope,
} from "../src/index.js";
import { FileKeyValueStorage } from "../src/file-storage.js";

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function envelope(schemaVersion: unknown, data: unknown = { sceneId: "scene_a", entities: {} }): SaveEnvelope {
  return {
    schemaVersion: schemaVersion as number,
    gameVersion: "0.0.0",
    slotId: "slot-a",
    savedAt: "2026-10-09T00:00:00.000Z",
    data,
  };
}

test("SaveMigrator rejects envelopes whose schemaVersion is missing or not a positive integer", () => {
  const migrator = createGameplaySaveMigrator();
  for (const bad of [undefined, null, Number.NaN, 0, -1, 1.5, "1", "2", Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => migrator.migrate(envelope(bad)),
      /schemaVersion must be an integer >= 1/,
      `schemaVersion ${String(bad)} must be rejected`,
    );
  }
  // A missing field used to be treated as current and skipped every migration.
  const { schemaVersion: _drop, ...withoutVersion } = envelope(1);
  assert.throws(() => migrator.migrate(withoutVersion as SaveEnvelope), /schemaVersion/);
});

test("SaveMigrator rejects non-object envelopes", () => {
  const migrator = createGameplaySaveMigrator();
  for (const bad of [null, undefined, 42, "save", []]) {
    assert.throws(() => migrator.migrate(bad as unknown as SaveEnvelope), /Save envelope must be an object/);
  }
});

test("SaveMigrator.register rejects invalid source versions", () => {
  const migrator = new SaveMigrator(5);
  for (const bad of [0, -1, 1.5, Number.NaN]) {
    assert.throws(() => migrator.register(bad, (data) => data), /integer >= 1/, `fromVersion ${bad}`);
  }
  assert.throws(() => migrator.register(5, (data) => data), /older than current/);
  migrator.register(1, (data) => data);
  assert.throws(() => migrator.register(1, (data) => data), /already registered/);
});

test("property: chained migrations run exactly once per version step and never mutate the input", () => {
  for (let seed = 1; seed <= 30; seed += 1) {
    const random = mulberry32(seed);
    const current = 2 + Math.floor(random() * 8);
    const migrator = new SaveMigrator(current);
    for (let version = 1; version < current; version += 1) {
      migrator.register(version, (data) => {
        const steps = (data as { steps: number[] }).steps;
        return { steps: [...steps, version] };
      });
    }
    const from = 1 + Math.floor(random() * current);
    const input = envelope(from, { steps: [] });
    const frozen = structuredClone(input);
    const migrated = migrator.migrate<{ steps: number[] }>(input);
    const expected = Array.from({ length: current - from }, (_, index) => from + index);
    assert.deepEqual(migrated.data.steps, expected, `seed=${seed}`);
    assert.equal(migrated.schemaVersion, current);
    assert.equal(migrated.slotId, input.slotId);
    assert.deepEqual(input, frozen, `input mutated: seed=${seed}`);
    assert.throws(() => migrator.migrate(envelope(current + 1 + Math.floor(random() * 3))), /newer/);
  }
});

test("FileKeyValueStorage rejects Windows reserved device names in any key form", async () => {
  const root = await mkdtemp(join(tmpdir(), "kinetra-reserved-"));
  try {
    const storage = new FileKeyValueStorage(root);
    for (const name of ["CON", "con", "Prn", "AUX", "nul", "COM1", "com9", "LPT1", "lpt9"]) {
      for (const key of [name, `saves:${name}`, `${name}.backup`]) {
        assert.throws(() => storage.resolveFilePath(key), /reserved/, `key ${key}`);
      }
    }
    // Lookalikes that are not device names stay legal.
    for (const key of ["console", "com10", "lpt0", "nullable", "saves:auxiliary", "settings:con"]) {
      assert.ok(storage.resolveFilePath(key).startsWith(root + sep), `key ${key}`);
    }
    await assert.rejects(() => storage.set("saves:nul", "{}"), /reserved/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("property: random keys either resolve inside the root as <key>.json or throw", () => {
  const storage = new FileKeyValueStorage(join(tmpdir(), "kinetra-fuzz-root"));
  const alphabet = "abcXYZ019_-./\\:~ $%\u0000\u00e9";
  const random = mulberry32(0xf11e);
  let accepted = 0;
  let rejected = 0;
  for (let index = 0; index < 3000; index += 1) {
    const length = 1 + Math.floor(random() * 12);
    let key = "";
    for (let char = 0; char < length; char += 1) {
      key += alphabet[Math.floor(random() * alphabet.length)];
    }
    if (random() < 0.2) key = `saves:${key}`;
    let resolved: string | undefined;
    try {
      resolved = storage.resolveFilePath(key);
    } catch (error) {
      assert.ok(error instanceof Error);
      rejected += 1;
      continue;
    }
    accepted += 1;
    assert.ok(resolved.startsWith(storage.rootDir + sep), `escaped root: ${JSON.stringify(key)}`);
    assert.ok(resolved.endsWith(".json"));
    const file = resolved.slice(storage.rootDir.length + 1);
    assert.ok(!file.includes(sep) && !file.includes("/"), `nested path: ${JSON.stringify(key)}`);
    assert.ok(!file.startsWith("."), `hidden/dot file: ${JSON.stringify(key)}`);
  }
  assert.ok(accepted > 100, `accepted=${accepted}`);
  assert.ok(rejected > 100, `rejected=${rejected}`);
});

test("SettingsStore drops malformed customBindings instead of passing them through", async () => {
  const cases: Array<[unknown, unknown]> = [
    ["not-an-object", undefined],
    [[["Space"]], undefined],
    [42, undefined],
    [{ jump: ["Space"], fire: "Mouse0", dash: null, crouch: [] }, { jump: ["Space"], crouch: [] }],
    [{ fire: "Mouse0" }, undefined],
  ];
  for (const [customBindings, expected] of cases) {
    const storage = new MemoryStorage();
    await storage.set(
      "settings:user-settings",
      JSON.stringify({ schemaVersion: 1, audio: { masterGain: 0.5, sfxGain: 0.5 }, display: { fullscreen: true }, input: { customBindings } }),
    );
    const loaded = await new SettingsStore(storage).load();
    assert.deepEqual(loaded.input?.customBindings, expected, JSON.stringify(customBindings));
    if (expected === undefined) assert.equal(loaded.input, undefined);
  }
});

test("property: SettingsStore.load never throws and always returns in-range settings", async () => {
  const random = mulberry32(0x5e77);
  const values: unknown[] = [null, true, false, 0, 1, -5, 7.5, 0.25, "x", "", [], {}, [1, 2], { a: 1 }];
  const anyValue = () => values[Math.floor(random() * values.length)];
  for (let index = 0; index < 400; index += 1) {
    const doc: Record<string, unknown> = {};
    if (random() < 0.8) doc.schemaVersion = anyValue();
    if (random() < 0.8) doc.audio = random() < 0.7 ? { masterGain: anyValue(), sfxGain: anyValue() } : anyValue();
    if (random() < 0.8) doc.display = random() < 0.7 ? { fullscreen: anyValue() } : anyValue();
    if (random() < 0.5) doc.input = random() < 0.7 ? { customBindings: random() < 0.5 ? { a: anyValue(), b: anyValue() } : anyValue() } : anyValue();
    const raw = random() < 0.1 ? JSON.stringify(anyValue()) : JSON.stringify(doc);
    const storage = new MemoryStorage();
    await storage.set("settings:user-settings", raw);
    const loaded = await new SettingsStore(storage).load();
    const context = raw;
    assert.equal(loaded.schemaVersion, 1, context);
    for (const gain of [loaded.audio.masterGain, loaded.audio.sfxGain]) {
      assert.ok(Number.isFinite(gain) && gain >= 0 && gain <= 1, `gain ${gain}: ${context}`);
    }
    assert.equal(typeof loaded.display.fullscreen, "boolean", context);
    if (loaded.input?.customBindings !== undefined) {
      const bindings = loaded.input.customBindings;
      assert.equal(Object.getPrototypeOf(bindings), Object.prototype, context);
      for (const value of Object.values(bindings)) assert.ok(Array.isArray(value), context);
    }
    // A loaded document round-trips through save/load unchanged.
    const store = new SettingsStore(storage);
    await store.save(loaded);
    assert.deepEqual(await store.load(), loaded, context);
  }
});
