import assert from "node:assert/strict";
import test from "node:test";

import {
  assertValidProject,
  type JsonObject,
  type ProjectDocument,
} from "@kinetra/project-model";

import { CommandBus, CommandError, type CommandResult, type EngineCommand } from "../src/index.js";

/**
 * Seeded, model-based property tests for the command bus. Each run drives a
 * random mix of valid and invalid commands against the bus and an independent
 * in-test reference model, then checks the bus invariants after every step.
 * Seeds are fixed so failures reproduce exactly (the seed is in the message).
 */

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

interface ModelEntity {
  sceneId: string;
  parentId?: string;
  components: Record<string, JsonObject>;
}

type Model = Map<string, ModelEntity>;

const SCENES = ["scene_alpha", "scene_beta"];
const ID_POOL = Array.from({ length: 12 }, (_, index) => `entity_${index}`);
const COMPONENTS = ["Transform", "Health", "Tag"];

function initialProject(): ProjectDocument {
  return {
    schemaVersion: 1,
    projectId: "project_property",
    name: "Property",
    scenes: SCENES.map((id) => ({ id, name: id, entities: [] })),
  };
}

function pick<T>(random: () => number, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)]!;
}

function descendantsOf(model: Model, rootId: string): Set<string> {
  const ids = new Set([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, entity] of model) {
      if (entity.parentId && ids.has(entity.parentId) && !ids.has(id)) {
        ids.add(id);
        changed = true;
      }
    }
  }
  return ids;
}

/** Applies a command to the reference model; returns false when the bus must reject it. */
function applyToModel(model: Model, command: EngineCommand): boolean {
  switch (command.command) {
    case "entity.create": {
      const { sceneId, entity } = command.payload;
      if (!SCENES.includes(sceneId) || model.has(entity.id)) return false;
      if (entity.parentId) {
        const parent = model.get(entity.parentId);
        if (!parent || parent.sceneId !== sceneId) return false;
      }
      model.set(entity.id, {
        sceneId,
        ...(entity.parentId ? { parentId: entity.parentId } : {}),
        components: structuredClone(entity.components) as Record<string, JsonObject>,
      });
      return true;
    }
    case "component.patch": {
      const entity = model.get(command.payload.entityId);
      if (!entity) return false;
      entity.components[command.payload.component] = {
        ...(entity.components[command.payload.component] ?? {}),
        ...structuredClone(command.payload.patch),
      };
      return true;
    }
    case "entity.reparent": {
      const entity = model.get(command.payload.entityId);
      if (!entity) return false;
      const parentId = command.payload.parentId;
      if (parentId === undefined) {
        delete entity.parentId;
        return true;
      }
      const parent = model.get(parentId);
      if (!parent || parent.sceneId !== entity.sceneId) return false;
      if (descendantsOf(model, command.payload.entityId).has(parentId)) return false;
      entity.parentId = parentId;
      return true;
    }
    case "entity.delete": {
      const id = command.payload.entityId;
      if (!model.has(id)) return false;
      const hasChildren = [...model.values()].some((entity) => entity.parentId === id);
      if (hasChildren && command.payload.cascade !== true) return false;
      for (const deleted of command.payload.cascade === true ? descendantsOf(model, id) : [id]) {
        model.delete(deleted);
      }
      return true;
    }
    case "scene.create":
      return false;
  }
}

function randomCommand(random: () => number, step: number): EngineCommand {
  const requestId = `req_${step}`;
  const roll = random();
  if (roll < 0.35) {
    const parent = random() < 0.5 ? pick(random, ID_POOL) : undefined;
    return {
      requestId,
      command: "entity.create",
      payload: {
        sceneId: random() < 0.95 ? pick(random, SCENES) : "scene_missing",
        entity: {
          id: pick(random, ID_POOL),
          name: `Entity ${step}`,
          ...(parent ? { parentId: parent } : {}),
          components: random() < 0.5 ? { Transform: { x: step } } : {},
        },
      },
    };
  }
  if (roll < 0.6) {
    return {
      requestId,
      command: "component.patch",
      payload: {
        entityId: pick(random, ID_POOL),
        component: pick(random, COMPONENTS),
        patch: { [pick(random, ["x", "y", "value"])]: Math.round(random() * 100) },
      },
    };
  }
  if (roll < 0.8) {
    return {
      requestId,
      command: "entity.reparent",
      payload: {
        entityId: pick(random, ID_POOL),
        ...(random() < 0.8 ? { parentId: pick(random, ID_POOL) } : {}),
      },
    };
  }
  return {
    requestId,
    command: "entity.delete",
    payload: { entityId: pick(random, ID_POOL), ...(random() < 0.5 ? { cascade: true } : {}) },
  };
}

function modelFromProject(project: ProjectDocument): Model {
  const model: Model = new Map();
  for (const scene of project.scenes) {
    for (const entity of scene.entities) {
      model.set(entity.id, {
        sceneId: scene.id,
        ...(entity.parentId ? { parentId: entity.parentId } : {}),
        components: structuredClone(entity.components) as Record<string, JsonObject>,
      });
    }
  }
  return model;
}

function sortedModel(model: Model): Array<[string, ModelEntity]> {
  return [...model.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

interface RunResult {
  events: ReturnType<CommandBus["eventLog"]>;
  successes: number;
  rejections: number;
}

function runSequence(seed: number, steps: number): RunResult {
  const random = mulberry32(seed);
  const initial = initialProject();
  const bus = new CommandBus(initial);
  const model: Model = new Map();
  const tokens: string[] = [];
  let successes = 0;
  let rejections = 0;

  for (let step = 0; step < steps; step += 1) {
    const command = randomCommand(random, step);
    const before = bus.snapshot();
    const dryRun = random() < 0.1;
    const expectedValid = applyToModel(dryRun ? modelFromProject(before.project) : model, command);
    const context = `seed=${seed} step=${step} ${JSON.stringify(command)}`;

    let result: CommandResult | undefined;
    let error: unknown;
    try {
      result = bus.execute(dryRun ? { ...command, dryRun: true } : command);
    } catch (caught) {
      error = caught;
    }

    if (!expectedValid) {
      assert.ok(error instanceof CommandError, `expected structured rejection: ${context} got ${String(error)}`);
      assert.deepEqual(bus.snapshot(), before, `rejection mutated state: ${context}`);
      rejections += 1;
      continue;
    }

    assert.equal(error, undefined, `unexpected rejection: ${context} ${String(error)}`);
    assert.ok(result);
    assert.ok(result.changes.length > 0, `no change records: ${context}`);
    assert.equal(result.proposedRevision, before.revision + 1, context);

    if (dryRun) {
      assert.equal(result.revision, before.revision, context);
      assert.equal(result.undoToken, undefined, context);
      assert.deepEqual(bus.snapshot(), before, `dry run mutated state: ${context}`);
      continue;
    }

    successes += 1;
    assert.equal(result.revision, before.revision + 1, context);
    assert.ok(result.undoToken, context);
    tokens.push(result.undoToken);

    const after = bus.snapshot();
    assertValidProject(after.project);
    assert.deepEqual(sortedModel(modelFromProject(after.project)), sortedModel(model), `model diverged: ${context}`);
  }

  // Snapshots are isolated copies.
  const leaked = bus.snapshot();
  leaked.project.scenes[0]!.entities.push({ id: "entity_leak", name: "Leak", components: {} });
  leaked.project.name = "mutated";
  assert.equal(bus.snapshot().project.name, "Property");
  assert.ok(!bus.snapshot().project.scenes[0]!.entities.some((entity) => entity.id === "entity_leak"));

  // Undoing every change in reverse restores the initial document exactly.
  const revisionBeforeUndo = bus.revision;
  for (const token of [...tokens].reverse()) {
    bus.undo(token);
  }
  assert.deepEqual(bus.snapshot().project, initial, `full undo did not restore initial: seed=${seed}`);
  assert.equal(bus.revision, revisionBeforeUndo + tokens.length);

  const events = bus.eventLog();
  assert.equal(events.length, successes * 2, `seed=${seed}`);
  events.forEach((event, index) => assert.equal(event.revision, index + 1, `event revisions: seed=${seed}`));

  return { events, successes, rejections };
}

const SEEDS = Array.from({ length: 40 }, (_, index) => 0x5eed + index * 7919);

test("random command sequences match the reference model and keep bus invariants", () => {
  let successes = 0;
  let rejections = 0;
  for (const seed of SEEDS) {
    const result = runSequence(seed, 150);
    successes += result.successes;
    rejections += result.rejections;
  }
  // The generator must exercise both paths meaningfully, or the property is vacuous.
  assert.ok(successes > SEEDS.length * 20, `too few successes: ${successes}`);
  assert.ok(rejections > SEEDS.length * 20, `too few rejections: ${rejections}`);
});

test("the same seed yields an identical event log (determinism)", () => {
  const first = runSequence(SEEDS[3]!, 120);
  const second = runSequence(SEEDS[3]!, 120);
  assert.deepEqual(second.events, first.events);
});

test("random transactions are all-or-nothing", () => {
  for (const seed of SEEDS.slice(0, 20)) {
    const random = mulberry32(seed ^ 0xa11);
    const bus = new CommandBus(initialProject());
    const model: Model = new Map();
    for (let step = 0; step < 40; step += 1) {
      const commands = Array.from({ length: 1 + Math.floor(random() * 4) }, (_, index) =>
        randomCommand(random, step * 10 + index),
      );
      const trial = structuredClone(model);
      const expectedValid = commands.every((command) => applyToModel(trial, command));
      const before = bus.snapshot();
      const context = `seed=${seed} step=${step}`;
      if (expectedValid) {
        bus.executeTransaction(commands);
        for (const [id, entity] of trial) model.set(id, entity);
        for (const id of [...model.keys()]) if (!trial.has(id)) model.delete(id);
        assert.equal(bus.revision, before.revision + 1, context);
        assert.deepEqual(sortedModel(modelFromProject(bus.snapshot().project)), sortedModel(model), context);
      } else {
        assert.throws(() => bus.executeTransaction(commands), CommandError, context);
        assert.deepEqual(bus.snapshot(), before, `partial transaction applied: ${context}`);
      }
    }
  }
});
