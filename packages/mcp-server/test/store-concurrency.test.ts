import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseProject, serializeProject, type ProjectDocument } from "@kinetra/project-model";

import { KinetraAgentService } from "../src/service.js";
import { FileProjectStore } from "../src/store.js";

function emptyProject(): ProjectDocument {
  return { schemaVersion: 1, projectId: "store-race", name: "Store race", scenes: [] };
}

test("concurrent mutating calls persist every revision without rename races (#133)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kinetra-store-race-"));
  try {
    const path = join(dir, "project.json");
    await writeFile(path, serializeProject(emptyProject()), "utf8");
    const service = await KinetraAgentService.fromFile(path);

    const results = await Promise.all(
      Array.from({ length: 25 }, (_, index) => service.createScene({ id: `scene-${String(index).padStart(2, "0")}`, name: `S${index}` })),
    );
    assert.ok(results.every((result) => result.ok), "every create should succeed");

    const onDisk = parseProject(await readFile(path, "utf8"));
    assert.equal(onDisk.scenes.length, 25);
    assert.deepEqual(
      onDisk.scenes.map((scene) => scene.id),
      service.bus.snapshot().project.scenes.map((scene) => scene.id).sort(),
    );
    const leftovers = (await readdir(dir)).filter((name) => name.includes(".tmp-"));
    assert.deepEqual(leftovers, [], "no temporary files left behind");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the snapshot saved last wins even when saves overlap", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kinetra-store-order-"));
  try {
    const store = new FileProjectStore(join(dir, "nested", "project.json"));
    const saves: Promise<void>[] = [];
    for (let index = 0; index < 10; index += 1) {
      saves.push(store.save({ ...emptyProject(), name: `rev-${index}` }));
    }
    await Promise.all(saves);
    assert.equal((await store.load()).name, "rev-9");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a failed save does not wedge later saves", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kinetra-store-fail-"));
  try {
    const store = new FileProjectStore(join(dir, "project.json"));
    await assert.rejects(() => store.save({ ...emptyProject(), name: "" }));
    await store.save({ ...emptyProject(), name: "after-failure" });
    assert.equal((await store.load()).name, "after-failure");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
