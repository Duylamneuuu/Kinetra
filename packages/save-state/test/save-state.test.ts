import assert from "node:assert/strict";
import test from "node:test";
import { JsonDocumentStore, MemoryStorage, SaveMigrator, createGameplaySaveMigrator, describeMissingSaveSlot, IpcKeyValueStorage, type GameplaySaveData, type PlatformStorageBridge } from "../src/index.js";

test("save migrations advance sequentially",()=>{
  const migrator=new SaveMigrator(3)
    .register(1,data=>({...data as object,coins:0}))
    .register(2,data=>({...data as object,chapter:1}));
  const result=migrator.migrate<{hp:number;coins:number;chapter:number}>({
    schemaVersion:1,gameVersion:"0.1",slotId:"slot-1",savedAt:"2026-09-19T00:00:00Z",
    data:{hp:10},
  });
  assert.equal(result.schemaVersion,3);
  assert.deepEqual(result.data,{hp:10,coins:0,chapter:1});
});

test("JSON document store round-trips settings/save data",async()=>{
  const storage=new MemoryStorage();
  const settings=new JsonDocumentStore<{volume:number}>(storage,"settings");
  await settings.save("global",{volume:0.75});
  assert.deepEqual(await settings.load("global"),{volume:0.75});
  await settings.remove("global");
  assert.equal(await settings.load("global"),undefined);
});

test("JSON document store lists ids for one prefix", async () => {
  const storage = new MemoryStorage();
  const saves = new JsonDocumentStore<{ ok: boolean }>(storage, "saves");
  const settings = new JsonDocumentStore<{ volume: number }>(storage, "settings");
  assert.deepEqual(await saves.list(), []);
  await saves.save("zeta", { ok: true });
  await saves.save("alpha", { ok: true });
  await settings.save("user", { volume: 1 });
  assert.deepEqual(await saves.list(), ["alpha", "zeta"]);
  assert.deepEqual(await settings.list(), ["user"]);
  await saves.remove("zeta");
  assert.deepEqual(await saves.list(), ["alpha"]);
});

test("IpcKeyValueStorage lists and sorts bridge ids", async () => {
  const bridge: PlatformStorageBridge = {
    async storageGet() {
      return undefined;
    },
    async storageSet() {},
    async storageDelete() {},
    async storageList(prefix) {
      assert.equal(prefix, "saves");
      return ["slot-b", "slot-a"];
    },
  };
  const storage = new IpcKeyValueStorage(bridge);
  assert.deepEqual(await storage.list("saves"), ["slot-a", "slot-b"]);
  const invalid: PlatformStorageBridge = {
    ...bridge,
    async storageList() {
      return ["ok", 1] as unknown as string[];
    },
  };
  await assert.rejects(
    () => new IpcKeyValueStorage(invalid).list("saves"),
    /string ids/,
  );
});

test("describeMissingSaveSlot names alternatives and caps the message", () => {
  const empty = describeMissingSaveSlot("missing", []);
  assert.deepEqual(empty.availableSlots, []);
  assert.match(empty.message, /No save slots exist/);
  assert.match(empty.message, /save\.list/);

  const slots = Array.from({ length: 14 }, (_, index) => `slot-${String(index).padStart(2, "0")}`);
  const described = describeMissingSaveSlot("missing", [...slots].reverse());
  assert.deepEqual(described.availableSlots, slots);
  assert.match(described.message, /slot-00, slot-01/);
  assert.match(described.message, /and 2 more/);
  assert.equal(described.message.includes("slot-12"), false);
});

test("createGameplaySaveMigrator migrates v1 state to v2 gameplay slice", () => {
  const migrator = createGameplaySaveMigrator();
  assert.equal(migrator.currentVersion, 2);

  const v1Save = {
    schemaVersion: 1,
    gameVersion: "0.1.0",
    slotId: "slot-1",
    savedAt: "2026-09-20T00:00:00Z",
    data: {
      sceneId: "main",
      entities: {
        hero: {
          position: [1.5, 0, 0] as [number, number, number],
          state: { moveCount: 5, jumpCount: 2 },
        },
      },
    },
  };

  const migrated = migrator.migrate<GameplaySaveData>(v1Save);
  assert.equal(migrated.schemaVersion, 2);
  assert.equal(migrated.data.sceneId, "main");
  assert.deepEqual(migrated.data.entities.hero, {
    position: [1.5, 0, 0],
    gameplay: { moveCount: 5, jumpCount: 2 },
  });
});

