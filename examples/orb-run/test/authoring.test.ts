import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { FileProjectStore, KinetraAgentService } from "@kinetra/mcp-server";
import { parseProject, serializeProject } from "@kinetra/project-model";

import {
  ORB_RUN_DEFAULT_RULES,
  ORB_RUN_ENTITY,
  ORB_RUN_ORB_IDS,
  ORB_RUN_RULES_COMPONENT,
  ORB_RUN_SCENE_ID,
  ORB_RUN_SCRIPT,
  authorOrbRunWithCommandBus,
  createEmptyOrbRunProject,
  createOrbRunProject,
  createOrbRunScriptRegistry,
  orbRunAuthoringPlan,
} from "../src/index.js";
import { connectMcpClient } from "./mcp-client.js";

const snapshotPath = fileURLToPath(new URL("../../orb-run.kinetra.json", import.meta.url));

interface MutationBody {
  ok: true;
  revision: number;
  undoToken?: string;
}

async function authorOverMcp(projectPath: string) {
  const store = new FileProjectStore(projectPath);
  await store.save(createEmptyOrbRunProject());
  const service = await KinetraAgentService.fromFile(projectPath);
  const client = connectMcpClient(service);
  const results: MutationBody[] = [];
  for (const step of orbRunAuthoringPlan()) {
    const { revision } = await client.callJson<{ revision: number }>("project.inspect", {});
    results.push(
      await client.callJson<MutationBody>(step.tool, { ...step.args, expectedProjectRevision: revision }),
    );
  }
  return { service, client, results };
}

test("Orb Run authored over MCP tools lands byte-for-byte on the checked-in snapshot", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orb-run-mcp-"));
  try {
    const projectPath = join(dir, "orb-run.kinetra.json");
    const { client, results } = await authorOverMcp(projectPath);
    try {
      const plan = orbRunAuthoringPlan();
      assert.equal(results.length, plan.length);
      results.forEach((result, index) => {
        assert.equal(result.ok, true);
        assert.equal(result.revision, index + 1, `step ${index} (${plan[index]!.tool}) is one revision`);
        assert.equal(typeof result.undoToken, "string");
      });

      const inspected = await client.callJson<{
        revision: number;
        scenes: Array<{ id: string; entityCount: number }>;
      }>("project.inspect", {});
      assert.equal(inspected.revision, plan.length);
      assert.deepEqual(inspected.scenes, [
        { id: ORB_RUN_SCENE_ID, name: "Orb Run Courtyard", entityCount: 10 },
      ]);

      const onDisk = await readFile(projectPath, "utf8");
      const checkedIn = await readFile(snapshotPath, "utf8");
      assert.equal(onDisk, checkedIn, "MCP-authored file must equal orb-run.kinetra.json");
    } finally {
      await client.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("command-bus authoring and the checked-in snapshot agree", async () => {
  const checkedIn = await readFile(snapshotPath, "utf8");
  assert.equal(serializeProject(createOrbRunProject()), checkedIn);
  assert.equal(serializeProject(parseProject(checkedIn)), checkedIn, "snapshot is canonical");

  const bus = authorOrbRunWithCommandBus();
  assert.equal(bus.revision, orbRunAuthoringPlan().length);
  const log = bus.eventLog();
  assert.equal(log.length, orbRunAuthoringPlan().length);
  assert.ok(log.every((event) => event.operation === "execute" && event.commands.length === 1));
});

test("MCP queries find gameplay entities without dumping the scene", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orb-run-query-"));
  try {
    const { client } = await authorOverMcp(join(dir, "orb-run.kinetra.json"));
    try {
      const scripted = await client.callJson<{
        total: number;
        items: Array<{ entity: { id: string; name: string; components: Record<string, unknown> } }>;
      }>("entity.query", { sceneId: ORB_RUN_SCENE_ID, component: "Script", selectComponents: ["Script"] });
      assert.equal(scripted.total, 5);
      const byScript = new Map<string, string[]>();
      for (const item of scripted.items) {
        assert.deepEqual(Object.keys(item.entity.components), ["Script"], "field selection respected");
        const scriptId = (item.entity.components.Script as { scriptId: string }).scriptId;
        byScript.set(scriptId, [...(byScript.get(scriptId) ?? []), item.entity.id]);
      }
      assert.deepEqual(byScript.get(ORB_RUN_SCRIPT.player), [ORB_RUN_ENTITY.player]);
      assert.deepEqual(byScript.get(ORB_RUN_SCRIPT.manager), [ORB_RUN_ENTITY.manager]);
      assert.deepEqual([...(byScript.get(ORB_RUN_SCRIPT.orb) ?? [])].sort(), [...ORB_RUN_ORB_IDS].sort());

      const rules = await client.callJson<{
        items: Array<{ entity: { components: Record<string, unknown> } }>;
      }>("entity.query", { ids: [ORB_RUN_ENTITY.manager], selectComponents: [ORB_RUN_RULES_COMPONENT] });
      assert.deepEqual(rules.items[0]?.entity.components[ORB_RUN_RULES_COMPONENT], ORB_RUN_DEFAULT_RULES);
    } finally {
      await client.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("stale MCP plans and duplicate ids fail with structured errors and no mutation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orb-run-errors-"));
  try {
    const projectPath = join(dir, "orb-run.kinetra.json");
    const { client } = await authorOverMcp(projectPath);
    try {
      const before = await readFile(projectPath, "utf8");
      const stale = await client.callTool("entity.patch", {
        entityId: ORB_RUN_ENTITY.manager,
        component: ORB_RUN_RULES_COMPONENT,
        patch: { timeLimitSeconds: 1 },
        expectedProjectRevision: 0,
      });
      assert.equal(stale.isError, true);
      assert.equal(JSON.parse(stale.content[0]?.text ?? "").code, "STALE_REVISION");

      const duplicate = await client.callTool("entity.create", {
        sceneId: ORB_RUN_SCENE_ID,
        id: ORB_RUN_ENTITY.orbA,
        name: "OrbA again",
      });
      assert.equal(duplicate.isError, true);
      assert.equal(JSON.parse(duplicate.content[0]?.text ?? "").code, "ENTITY_ALREADY_EXISTS");

      assert.equal(await readFile(projectPath, "utf8"), before, "failed tools leave the file untouched");
    } finally {
      await client.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a rules patch over MCP is undoable and restores the original bytes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orb-run-undo-"));
  try {
    const projectPath = join(dir, "orb-run.kinetra.json");
    const { client } = await authorOverMcp(projectPath);
    try {
      const original = await readFile(projectPath, "utf8");
      const patched = await client.callJson<MutationBody>("entity.patch", {
        entityId: ORB_RUN_ENTITY.manager,
        component: ORB_RUN_RULES_COMPONENT,
        patch: { timeLimitSeconds: 5 },
      });
      const afterPatch = parseProject(await readFile(projectPath, "utf8"));
      const manager = afterPatch.scenes[0]?.entities.find((entity) => entity.id === ORB_RUN_ENTITY.manager);
      assert.deepEqual(manager?.components[ORB_RUN_RULES_COMPONENT], {
        ...ORB_RUN_DEFAULT_RULES,
        timeLimitSeconds: 5,
      });

      await client.callJson<MutationBody>("project.undo", { undoToken: patched.undoToken });
      assert.equal(await readFile(projectPath, "utf8"), original);
    } finally {
      await client.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("every authored Script resolves and every entity is placed", () => {
  const project = createOrbRunProject();
  const registry = createOrbRunScriptRegistry(project, ORB_RUN_SCENE_ID);
  const scene = project.scenes.find((candidate) => candidate.id === ORB_RUN_SCENE_ID);
  assert.ok(scene);
  for (const entity of scene.entities) {
    assert.ok(entity.components.Transform, `${entity.name} has a Transform`);
    const script = entity.components.Script as { scriptId?: unknown } | undefined;
    if (script) {
      assert.equal(typeof script.scriptId, "string");
      assert.ok(registry.resolve(script.scriptId as string), `${entity.name} script resolves`);
    }
  }
});
