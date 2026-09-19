import assert from "node:assert/strict";
import test from "node:test";
import { JsonDocumentStore, MemoryStorage, SaveMigrator } from "../src/index.js";

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
