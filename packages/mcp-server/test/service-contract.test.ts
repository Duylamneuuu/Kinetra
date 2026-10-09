import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  parseProject,
  serializeProject,
  type ProjectDocument,
} from "@kinetra/project-model";

import { KinetraAgentService, LocalRuntimeHost } from "../src/index.js";
import { compareCodeUnits } from "../src/order.js";

const transform = {
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
};

function project(sceneIds: string[]): ProjectDocument {
  return {
    schemaVersion: 1,
    projectId: "project-contract",
    name: "Contract",
    scenes: sceneIds.map((id) => ({ id, name: `Scene ${id}`, entities: [] })),
  };
}

test("compareCodeUnits orders by UTF-16 code unit, not by host locale", () => {
  assert.equal(compareCodeUnits("a", "a"), 0);
  assert.equal(compareCodeUnits("B", "a"), -1, "uppercase sorts before lowercase");
  assert.equal(compareCodeUnits("a", "B"), 1);
  assert.deepEqual(["é", "a", "Z", "B", "ab", "a-"].sort(compareCodeUnits), ["B", "Z", "a", "a-", "ab", "é"]);
});

test("inspectProject and queryScenes list scenes in code-unit order of their ids", () => {
  const service = new KinetraAgentService(project(["scene-é", "scene-a", "scene-B", "scene-Z"]));
  const expected = ["scene-B", "scene-Z", "scene-a", "scene-é"];

  assert.deepEqual(service.inspectProject().scenes.map((scene) => scene.id), expected);
  assert.deepEqual(service.queryScenes().map((scene) => scene.id), expected);
  assert.deepEqual(service.queryScenes("scene-a").map((scene) => scene.id), ["scene-a"]);
  assert.deepEqual(service.queryScenes("scene-missing"), []);
});

test("runtime query lists entities in code-unit order and honours entityIds filters", async () => {
  const service = new KinetraAgentService(project(["scene-main"]));
  for (const id of ["entity-b", "entity-a", "entity-B", "entity-é"]) {
    const created = await service.createEntity({ sceneId: "scene-main", id, name: id, components: { Transform: transform } });
    assert.equal(created.ok, true);
  }

  await service.startRuntime("scene-main");
  try {
    const all = await service.queryRuntime();
    assert.equal(all.running, true);
    assert.equal(all.sceneId, "scene-main");
    assert.deepEqual(
      all.entities.map((entity) => entity.entityId),
      ["entity-B", "entity-a", "entity-b", "entity-é"],
    );

    const filtered = await service.queryRuntime({ entityIds: ["entity-b", "entity-missing"] });
    assert.deepEqual(filtered.entities.map((entity) => entity.entityId), ["entity-b"]);

    const none = await service.queryRuntime({ entityIds: [] });
    assert.deepEqual(none.entities, []);
  } finally {
    await service.stopRuntime();
  }
});

test("diffSince only reports events after the given revision", async () => {
  const service = new KinetraAgentService(project(["scene-main"]));
  await service.createEntity({ sceneId: "scene-main", id: "e1", name: "One" });
  await service.createEntity({ sceneId: "scene-main", id: "e2", name: "Two" });

  const everything = service.diffSince(0);
  assert.equal(everything.currentRevision, 2);
  assert.deepEqual(everything.events.map((event) => event.revision), [1, 2]);

  const later = service.diffSince(1);
  assert.deepEqual(later.events.map((event) => event.revision), [2]);
  assert.deepEqual(service.diffSince(2).events, []);
  assert.deepEqual(service.diffSince(99).events, []);
});

test("create/patch/reparent/delete/undo each persist to disk", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kinetra-svc-contract-"));
  try {
    const path = join(dir, "game.kinetra.json");
    await writeFile(path, serializeProject(project(["scene-main"])), "utf8");
    const service = await KinetraAgentService.fromFile(path);
    const load = async () => parseProject(await readFile(path, "utf8"));

    await service.createEntity({ sceneId: "scene-main", id: "parent", name: "Parent", components: { Transform: transform } });
    await service.createEntity({ sceneId: "scene-main", id: "child", name: "Child", parentId: "parent" });
    assert.equal((await load()).scenes[0]?.entities.find((entity) => entity.id === "child")?.parentId, "parent");

    const reparented = await service.reparentEntity({ entityId: "child" });
    assert.equal(reparented.ok, true);
    assert.equal((await load()).scenes[0]?.entities.find((entity) => entity.id === "child")?.parentId, undefined);

    const patched = await service.patchComponent({ entityId: "parent", component: "Transform", patch: { position: [4, 5, 6] } });
    assert.equal(patched.ok, true);
    assert.deepEqual(
      (await load()).scenes[0]?.entities.find((entity) => entity.id === "parent")?.components.Transform,
      { ...transform, position: [4, 5, 6] },
    );

    const created = await service.createScene({ id: "scene-extra", name: "Extra" });
    assert.deepEqual((await load()).scenes.map((scene) => scene.id).sort(), ["scene-extra", "scene-main"]);
    assert.ok(created.undoToken);

    const undone = await service.undo(created.undoToken as string);
    assert.equal(undone.ok, true);
    assert.deepEqual((await load()).scenes.map((scene) => scene.id), ["scene-main"]);

    const deleted = await service.deleteEntity({ entityId: "parent", cascade: true });
    assert.equal(deleted.ok, true);
    // "child" was reparented to the scene root above, so cascading from "parent" must leave it alone.
    assert.deepEqual((await load()).scenes[0]?.entities.map((entity) => entity.id), ["child"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a rejected command does not touch disk or the revision", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kinetra-svc-reject-"));
  try {
    const path = join(dir, "game.kinetra.json");
    await writeFile(path, serializeProject(project(["scene-main"])), "utf8");
    const before = await readFile(path, "utf8");
    const service = await KinetraAgentService.fromFile(path);

    await assert.rejects(
      service.patchComponent({ entityId: "missing", component: "Transform", patch: { position: [1, 2, 3] } }),
      (error: Error & { code?: string }) => typeof error.code === "string" && error.code.length > 0,
    );
    await assert.rejects(service.createEntity({ sceneId: "scene-missing", id: "x", name: "X" }));
    await assert.rejects(service.undo("undo-token-that-does-not-exist"));

    assert.equal(service.bus.revision, 0);
    assert.equal(await readFile(path, "utf8"), before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runAcceptance rejects malformed input with coded infrastructure errors", async () => {
  const service = new KinetraAgentService(project(["scene-main"]));
  const manifest = { schemaVersion: 1, id: "m", name: "m", scene: "scene-main", steps: [] };
  const code = (expected: string) => (error: Error & { code?: string }) => {
    assert.equal(error.code, expected);
    return true;
  };

  await assert.rejects(service.runAcceptance({ manifest: undefined as never }), code("INVALID_MANIFEST"));
  await assert.rejects(service.runAcceptance({ manifest: null as never }), code("INVALID_MANIFEST"));
  await assert.rejects(
    service.runAcceptance({ manifest: { ...manifest, schemaVersion: 2 } as never }),
    code("UNSUPPORTED_SCHEMA_VERSION"),
  );
  await assert.rejects(
    service.runAcceptance({ manifest: manifest as never, target: "browser" as never }),
    code("INVALID_TARGET"),
  );
  await assert.rejects(
    service.runAcceptance({ manifest: manifest as never, project: { scenes: "nope" } as never }),
    code("INVALID_PROJECT"),
  );
});

test("LocalRuntimeHost lifecycle: idle queries, failed start, restart, idempotent stop, log cursor", async () => {
  const host = new LocalRuntimeHost();
  const doc: ProjectDocument = {
    ...project(["scene-main"]),
    scenes: [
      {
        id: "scene-main",
        name: "Main",
        entities: [{ id: "e1", name: "One", components: { Transform: transform } }],
      },
    ],
  };

  assert.deepEqual(await host.query(), { running: false, entities: [] });
  assert.deepEqual(await host.step(), { running: false, entities: [] });
  await host.stop();
  assert.deepEqual(await host.readLogs(), [], "stopping an idle host logs nothing");
  await assert.rejects(host.injectInput({ action: "jump", phase: "press" }), /not running/);

  await host.start(doc, "scene-main", 3);
  assert.equal((await host.query()).projectRevision, 3);

  await assert.rejects(host.start(doc, "scene-missing", 4));
  assert.equal((await host.query()).running, false, "a failed start leaves the host stopped, not half-started");

  await host.start(doc, "scene-main", 5);
  assert.equal((await host.query()).projectRevision, 5);
  await host.stop();
  await host.stop();

  const logs = await host.readLogs();
  assert.deepEqual(
    logs.map((entry) => entry.sequence),
    logs.map((_, index) => index + 1),
    "log sequence numbers are gapless and increasing",
  );
  assert.deepEqual(
    logs.map((entry) => entry.message),
    ["runtime.started", "runtime.stopped", "runtime.started", "runtime.stopped"],
  );
  const cursor = logs[1]?.sequence ?? 0;
  assert.deepEqual((await host.readLogs(cursor)).map((entry) => entry.sequence), [3, 4]);
  assert.deepEqual(await host.readLogs(99), []);

  const first = await host.readLogs();
  (first[0] as { message: string }).message = "mutated";
  assert.equal((await host.readLogs())[0]?.message, "runtime.started", "returned logs are copies");
});
