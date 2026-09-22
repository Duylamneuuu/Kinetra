import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseProject, serializeProject } from "@kinetra/project-model";

import { KinetraAgentService } from "../src/index.js";

test("starter project round-trips and can be patched then undone", async () => {
  const path = repoFile("examples/starter/game.kinetra.json");
  const text = await readFile(path, "utf8");
  const project = parseProject(text);

  assert.equal(serializeProject(project), text);
  assert.equal(project.name, "Starter");
  assert.equal(project.scenes.length, 1);
  assert.equal(project.scenes[0]?.entities.length, 3);

  const service = new KinetraAgentService(project);
  const inspected = service.inspectProject();
  assert.equal(inspected.revision, 0);
  assert.equal(inspected.scenes.length, 1);
  assert.equal(inspected.scenes[0]?.entityCount, 3);

  const box = service.queryEntities({ nameContains: "Box" }).items.find(
    (item) => item.entity.name === "Box",
  );
  assert.ok(box);
  const transform = box.entity.components.Transform as { position: number[] };
  assert.deepEqual(transform.position, [0, 0.5, 0]);

  const patched = await service.patchComponent({
    entityId: box.entity.id,
    component: "Transform",
    expectedProjectRevision: 0,
    patch: { position: [2, 0.5, 0] },
  });
  assert.equal(patched.revision, 1);
  assert.equal(typeof patched.undoToken, "string");

  const moved = service
    .queryEntities({ ids: [box.entity.id] })
    .items[0]?.entity.components.Transform as { position: number[] };
  assert.deepEqual(moved.position, [2, 0.5, 0]);

  const undone = await service.undo(patched.undoToken ?? "", 1);
  assert.equal(undone.revision, 2);
  const restored = service
    .queryEntities({ ids: [box.entity.id] })
    .items[0]?.entity.components.Transform as { position: number[] };
  assert.deepEqual(restored.position, [0, 0.5, 0]);
  assert.equal(service.inspectProject().revision, 2);
  assert.equal(
    service.diffSince(1).events.some((event) => event.operation === "undo"),
    true,
  );
  assert.equal(await readFile(path, "utf8"), text);
});

function repoFile(relative: string): string {
  let current = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(join(current, "pnpm-workspace.yaml"))) {
      return join(current, relative);
    }
    current = dirname(current);
  }
  throw new Error("Could not find the repository root");
}
