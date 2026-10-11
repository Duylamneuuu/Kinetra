import assert from "node:assert/strict";
import test from "node:test";

import { hashBytes } from "@kinetra/asset-pipeline";

import {
  ORB_RUN_AUDIO_ASSET,
  ORB_RUN_ENTITY,
  ORB_RUN_MODEL_ASSET,
  ORB_RUN_MODEL_ASSET_IDS,
  ORB_RUN_MODEL_BINDINGS,
  ORB_RUN_WINNING_ROUTE,
  createOrbRunAudioBytes,
  createOrbRunHotReload,
  createOrbRunModelBytes,
  digestOrbRunState,
  startOrbRunSimulation,
  summarizeOrbRun,
  walkTo,
  type OrbRunHotReload,
} from "../src/index.js";

const ALL_ENTITIES = Object.values(ORB_RUN_ENTITY).sort();
const ORB_ENTITIES = [ORB_RUN_ENTITY.orbA, ORB_RUN_ENTITY.orbB, ORB_RUN_ENTITY.orbC].sort();
const RED: [number, number, number, number] = [0.9, 0.1, 0.1, 1];
const BLUE: [number, number, number, number] = [0.1, 0.1, 0.9, 1];
const GREEN: [number, number, number, number] = [0.1, 0.9, 0.1, 1];

const eventTypes = (hot: OrbRunHotReload): string[] => hot.events.map((event) => event.type);

async function withHotReload(run: (hot: OrbRunHotReload) => Promise<void>): Promise<void> {
  const hot = await createOrbRunHotReload();
  try {
    await run(hot);
  } finally {
    await hot.stop();
  }
}

test("scene start: every model entity shows exactly the imported artifact of its asset", async () => {
  await withHotReload(async (hot) => {
    assert.equal(hot.coordinator.isStarted(), true);
    assert.deepEqual(Object.keys(ORB_RUN_MODEL_BINDINGS).sort(), [
      ORB_RUN_ENTITY.exit,
      ORB_RUN_ENTITY.orbA,
      ORB_RUN_ENTITY.orbB,
      ORB_RUN_ENTITY.orbC,
      ORB_RUN_ENTITY.player,
    ].sort());
    for (const [entityId, assetId] of Object.entries(ORB_RUN_MODEL_BINDINGS)) {
      const record = hot.pipeline.database.get(assetId)!;
      const artifact = await hot.pipeline.fileSystem.readFile(record.importedPath);
      assert.deepEqual(hot.target.appliedTo(entityId), {
        assetId,
        fingerprint: record.fingerprint,
        bytesHash: hashBytes(artifact),
      });
    }
    // Entities without a model (floor, camera, lights, manager) show nothing.
    assert.equal(hot.target.appliedTo(ORB_RUN_ENTITY.floor), undefined);
    assert.equal(hot.target.appliedTo(ORB_RUN_ENTITY.manager), undefined);
    assert.deepEqual(
      (await hot.target.queryEntities()).map((entity) => entity.entityId),
      ALL_ENTITIES,
    );
    for (const assetId of ORB_RUN_MODEL_ASSET_IDS) {
      assert.equal(hot.target.updateCount(assetId), 1);
      assert.equal(hot.target.reloadCount(assetId), 1);
    }
    assert.deepEqual(hot.transactions, [], "loading the scene is not a hot reload");
  });
});

test("an artist repaints the orb: only the orb model reloads, on exactly the three orb entities", async () => {
  await withHotReload(async (hot) => {
    const before = hot.pipeline.database.get(ORB_RUN_MODEL_ASSET.orb)!.fingerprint;
    const exitBefore = hot.target.appliedTo(ORB_RUN_ENTITY.exit);
    const playerBefore = hot.target.appliedTo(ORB_RUN_ENTITY.player);

    const tx = await hot.editSource(ORB_RUN_MODEL_ASSET.orb, await createOrbRunModelBytes(ORB_RUN_MODEL_ASSET.orb, { color: RED }));
    assert.ok(tx, "a changed source is a transaction");
    const record = hot.pipeline.database.get(ORB_RUN_MODEL_ASSET.orb)!;

    assert.equal(tx.rootAssetId, ORB_RUN_MODEL_ASSET.orb);
    assert.deepEqual(tx.rebuiltAssetIds, [ORB_RUN_MODEL_ASSET.orb]);
    assert.equal(tx.failedAssetId, undefined);
    assert.equal(tx.error, undefined);
    assert.equal(tx.oldFingerprint, before);
    assert.equal(tx.newFingerprint, record.fingerprint);
    assert.notEqual(record.fingerprint, before);
    assert.deepEqual([...tx.runtimeReloadedEntityIds].sort(), ORB_ENTITIES);
    assert.deepEqual(
      [...tx.runtimeUnchangedEntityIds].sort(),
      ALL_ENTITIES.filter((id) => !ORB_ENTITIES.includes(id)),
    );

    const artifact = await hot.pipeline.fileSystem.readFile(record.importedPath);
    for (const entityId of ORB_ENTITIES) {
      assert.deepEqual(hot.target.appliedTo(entityId), {
        assetId: ORB_RUN_MODEL_ASSET.orb,
        fingerprint: record.fingerprint,
        bytesHash: hashBytes(artifact),
      });
    }
    assert.deepEqual(hot.target.appliedTo(ORB_RUN_ENTITY.exit), exitBefore, "the exit pad is untouched");
    assert.deepEqual(hot.target.appliedTo(ORB_RUN_ENTITY.player), playerBefore, "the runner is untouched");
    assert.equal(hot.target.updateCount(ORB_RUN_MODEL_ASSET.orb), 2);
    assert.equal(hot.target.updateCount(ORB_RUN_MODEL_ASSET.exitPad), 1);
    assert.equal(hot.target.updateCount(ORB_RUN_MODEL_ASSET.player), 1);

    const types = eventTypes(hot);
    assert.ok(types.includes("asset.reimportSucceeded"), `reimport event in ${types.join(",")}`);
    assert.ok(
      types.indexOf("asset.reimportSucceeded") < types.indexOf("asset.runtimeReloadStarted"),
      "the runtime is told after the import finished",
    );
    assert.ok(types.indexOf("asset.runtimeReloadStarted") < types.indexOf("asset.runtimeReloadSucceeded"));
    assert.equal(types.filter((type) => type === "asset.runtimeReloadFailed").length, 0);
    assert.deepEqual(hot.transactions, [tx]);
  });
});

test("saving the same bytes again is a no-op: no transaction, nothing reaches the runtime", async () => {
  await withHotReload(async (hot) => {
    const original = hot.pipeline.sources[ORB_RUN_MODEL_ASSET.exitPad]!;
    assert.equal(await hot.editSource(ORB_RUN_MODEL_ASSET.exitPad, original), null);
    assert.equal(hot.target.updateCount(ORB_RUN_MODEL_ASSET.exitPad), 1);
    assert.deepEqual(hot.transactions, []);

    // Edit and then revert: the revert is a real change back to the first fingerprint.
    const firstFingerprint = hot.pipeline.database.get(ORB_RUN_MODEL_ASSET.exitPad)!.fingerprint;
    await hot.editSource(ORB_RUN_MODEL_ASSET.exitPad, await createOrbRunModelBytes(ORB_RUN_MODEL_ASSET.exitPad, { color: BLUE }));
    const revert = await hot.editSource(ORB_RUN_MODEL_ASSET.exitPad, original);
    assert.ok(revert);
    assert.equal(revert.newFingerprint, firstFingerprint);
    assert.equal(hot.target.appliedTo(ORB_RUN_ENTITY.exit)?.fingerprint, firstFingerprint);
    assert.equal(hot.transactions.length, 2);
  });
});

test("a corrupt source keeps the last good model on screen and is reported, not pushed to the runtime", async () => {
  await withHotReload(async (hot) => {
    const playerId = ORB_RUN_MODEL_ASSET.player;
    const good = hot.pipeline.sources[playerId]!;
    const goodRecord = structuredClone(hot.pipeline.database.get(playerId)!);
    const shown = hot.target.appliedTo(ORB_RUN_ENTITY.player);

    const tx = await hot.editSource(playerId, good.slice(0, 20));
    assert.ok(tx, "a failed import is still a transaction the agent can read");
    assert.equal(tx.failedAssetId, playerId);
    assert.ok(tx.error && tx.error.length > 0);
    assert.deepEqual(tx.rebuiltAssetIds, []);
    assert.deepEqual(tx.runtimeReloadedEntityIds, []);

    assert.deepEqual(hot.pipeline.database.get(playerId), goodRecord, "the record keeps its last good import");
    assert.deepEqual(hot.target.appliedTo(ORB_RUN_ENTITY.player), shown, "the runner still shows the last good model");
    assert.equal(hot.target.updateCount(playerId), 1, "the runtime never saw the broken bytes");
    assert.ok(eventTypes(hot).includes("asset.reimportFailed"));
    assert.equal(eventTypes(hot).includes("asset.runtimeReloadStarted"), false);

    // Fixing the file back to what was last imported changes nothing for the runtime.
    assert.equal(await hot.editSource(playerId, good), null);
    assert.deepEqual(hot.target.appliedTo(ORB_RUN_ENTITY.player), shown);

    // A different, valid edit afterwards goes through.
    const fixed = await hot.editSource(playerId, await createOrbRunModelBytes(playerId, { color: GREEN }));
    assert.ok(fixed);
    assert.deepEqual(fixed.runtimeReloadedEntityIds, [ORB_RUN_ENTITY.player]);
    assert.notEqual(hot.target.appliedTo(ORB_RUN_ENTITY.player)?.fingerprint, shown?.fingerprint);
  });
});

test("an audio edit reloads with zero affected entities and updates the published cue", async () => {
  await withHotReload(async (hot) => {
    const cue = ORB_RUN_AUDIO_ASSET.pickups[0]!;
    const original = createOrbRunAudioBytes()[cue]!;
    const edited = new Uint8Array(original);
    edited[edited.length - 1] = edited[edited.length - 1]! ^ 0x7f;
    const before = hot.pipeline.database.get(cue)!.fingerprint;
    const modelsBefore = ORB_RUN_MODEL_ASSET_IDS.map((id) => hot.target.appliedTo(Object.entries(ORB_RUN_MODEL_BINDINGS).find(([, a]) => a === id)![0]));

    const tx = await hot.editSource(cue, edited);
    assert.ok(tx);
    assert.deepEqual(tx.rebuiltAssetIds, [cue]);
    assert.deepEqual(tx.runtimeReloadedEntityIds, []);
    assert.deepEqual([...tx.runtimeUnchangedEntityIds].sort(), ALL_ENTITIES);
    const after = hot.pipeline.database.get(cue)!.fingerprint;
    assert.notEqual(after, before);
    assert.equal(hot.target.stagedFingerprint(cue), after);
    assert.equal(hot.target.reloadCount(cue), 2);
    assert.deepEqual(
      ORB_RUN_MODEL_ASSET_IDS.map((id) => hot.target.appliedTo(Object.entries(ORB_RUN_MODEL_BINDINGS).find(([, a]) => a === id)![0])),
      modelsBefore,
      "no model changed",
    );
    assert.ok(eventTypes(hot).includes("asset.runtimeReloadSucceeded"));
  });
});

test("a runtime that refuses, fails or crashes is reported per asset and recovers on the next edit", async () => {
  await withHotReload(async (hot) => {
    const orbId = ORB_RUN_MODEL_ASSET.orb;
    const orbEntity = ORB_RUN_ENTITY.orbA;
    const shown = hot.target.appliedTo(orbEntity)!;
    const failureErrors = (): string[] =>
      hot.events.filter((event) => event.type === "asset.runtimeReloadFailed").map((event) => event.error ?? "");

    // 1. The runtime refuses the new bytes (updateAsset throws): the import succeeded, nothing reloaded.
    hot.target.faults.refuseUpdate.add(orbId);
    const refused = await hot.editSource(orbId, await createOrbRunModelBytes(orbId, { color: RED }));
    assert.ok(refused, "a refusal must not lose the transaction");
    assert.deepEqual(refused.rebuiltAssetIds, [orbId]);
    assert.deepEqual(refused.runtimeReloadedEntityIds, []);
    assert.equal(failureErrors().length, 1);
    assert.match(failureErrors()[0]!, /refused/);
    assert.deepEqual(hot.target.appliedTo(orbEntity), shown, "the screen still shows the old model");
    assert.notEqual(
      hot.pipeline.database.get(orbId)!.fingerprint,
      shown.fingerprint,
      "the database moved on: the transaction report is how the drift is found",
    );
    hot.target.faults.refuseUpdate.delete(orbId);

    // 2. reloadAsset answers success:false.
    hot.target.faults.failReload.add(orbId);
    const failed = await hot.editSource(orbId, await createOrbRunModelBytes(orbId, { color: BLUE }));
    assert.ok(failed);
    assert.deepEqual(failed.runtimeReloadedEntityIds, []);
    assert.equal(failureErrors().length, 2);
    assert.match(failureErrors()[1]!, /could not reload/);
    assert.deepEqual(hot.target.appliedTo(orbEntity), shown);
    hot.target.faults.failReload.delete(orbId);

    // 3. reloadAsset throws.
    hot.target.faults.throwOnReload.add(orbId);
    const crashed = await hot.editSource(orbId, await createOrbRunModelBytes(orbId, { color: GREEN }));
    assert.ok(crashed);
    assert.deepEqual(crashed.runtimeReloadedEntityIds, []);
    assert.equal(failureErrors().length, 3);
    assert.match(failureErrors()[2]!, /crashed/);
    hot.target.faults.throwOnReload.clear();

    // 4. A healthy runtime picks up the next edit and every orb catches up with the database.
    const healed = await hot.editSource(orbId, await createOrbRunModelBytes(orbId, { color: [0.5, 0.5, 0.5, 1] }));
    assert.ok(healed);
    assert.deepEqual([...healed.runtimeReloadedEntityIds].sort(), ORB_ENTITIES);
    const fingerprint = hot.pipeline.database.get(orbId)!.fingerprint;
    for (const entityId of ORB_ENTITIES) assert.equal(hot.target.appliedTo(entityId)?.fingerprint, fingerprint);
    assert.equal(hot.transactions.length, 4, "every attempt produced exactly one transaction");
  });
});

test("a runtime loader that cannot parse the bytes refuses them (the importer is not the only gate)", async () => {
  const { OrbRunReloadTarget } = await import("../src/index.js");
  const target = new OrbRunReloadTarget();
  const junk = Buffer.from("definitely not a glb").toString("base64");
  await assert.rejects(target.updateAsset(ORB_RUN_MODEL_ASSET.orb, junk), /GLB|glb|magic|header/i);
  await assert.rejects(target.updateAsset(ORB_RUN_MODEL_ASSET.orb, ""), /empty/);
  assert.equal(target.updateCount(ORB_RUN_MODEL_ASSET.orb), 0);
  const never = await target.reloadAsset(ORB_RUN_MODEL_ASSET.orb);
  assert.equal(never.success, false);
  assert.deepEqual(never.affectedEntities, []);
});

test("edits to different assets in flight together run one after the other, in call order", async () => {
  await withHotReload(async (hot) => {
    const [orbTx, padTx, playerTx] = await Promise.all([
      hot.editSource(ORB_RUN_MODEL_ASSET.orb, await createOrbRunModelBytes(ORB_RUN_MODEL_ASSET.orb, { color: RED })),
      hot.editSource(ORB_RUN_MODEL_ASSET.exitPad, await createOrbRunModelBytes(ORB_RUN_MODEL_ASSET.exitPad, { color: BLUE })),
      hot.editSource(ORB_RUN_MODEL_ASSET.player, await createOrbRunModelBytes(ORB_RUN_MODEL_ASSET.player, { color: GREEN })),
    ]);
    assert.ok(orbTx && padTx && playerTx);
    assert.deepEqual(
      hot.transactions.map((tx) => tx.rootAssetId),
      [ORB_RUN_MODEL_ASSET.orb, ORB_RUN_MODEL_ASSET.exitPad, ORB_RUN_MODEL_ASSET.player],
    );
    assert.deepEqual(padTx.runtimeReloadedEntityIds, [ORB_RUN_ENTITY.exit]);
    assert.deepEqual(playerTx.runtimeReloadedEntityIds, [ORB_RUN_ENTITY.player]);
    // Whatever the order, the screen ends up on what the database holds.
    for (const [entityId, assetId] of Object.entries(ORB_RUN_MODEL_BINDINGS)) {
      assert.equal(hot.target.appliedTo(entityId)?.fingerprint, hot.pipeline.database.get(assetId)!.fingerprint);
    }
  });
});

test("unknown assets: editing throws, processing one is a quiet no-op", async () => {
  await withHotReload(async (hot) => {
    await assert.rejects(hot.editSource("asset_nope", new Uint8Array([1])), /Unknown Orb Run asset/);
    assert.equal(await hot.coordinator.processAssetChange("asset_nope"), null);
    assert.deepEqual(hot.transactions, []);
  });
});

test("reloading art in the middle of a run changes no gameplay: same digest now, same ending as an untouched run", async () => {
  const hot = await createOrbRunHotReload();
  try {
    const reloaded = await startOrbRunSimulation();
    const untouched = await startOrbRunSimulation();
    const [first, second, ...rest] = ORB_RUN_WINNING_ROUTE;
    for (const sim of [reloaded, untouched]) {
      walkTo(sim, first!);
      walkTo(sim, second!);
    }
    assert.equal(summarizeOrbRun(reloaded).collectedCount, 2);
    const digestBefore = digestOrbRunState(reloaded);

    for (const id of [ORB_RUN_MODEL_ASSET.orb, ORB_RUN_MODEL_ASSET.exitPad, ORB_RUN_MODEL_ASSET.player]) {
      const tx = await hot.editSource(id, await createOrbRunModelBytes(id, { color: RED }));
      assert.ok(tx && tx.runtimeReloadedEntityIds.length > 0);
    }
    assert.equal(digestOrbRunState(reloaded), digestBefore, "a reload moves nothing and writes no script state");

    for (const sim of [reloaded, untouched]) for (const target of rest) walkTo(sim, target);
    assert.equal(summarizeOrbRun(reloaded).status, "won");
    assert.equal(digestOrbRunState(reloaded), digestOrbRunState(untouched));
  } finally {
    await hot.stop();
  }
});

test("stopping the coordinator ends the session", async () => {
  const hot = await createOrbRunHotReload();
  assert.equal(hot.coordinator.isStarted(), true);
  await hot.stop();
  assert.equal(hot.coordinator.isStarted(), false);
});
