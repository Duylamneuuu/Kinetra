import assert from "node:assert/strict";
import test from "node:test";

import { collectPhysicsSceneDiagnostics } from "@kinetra/physics-rapier";
import type { SceneDefinition } from "@kinetra/project-model";

import { logPhysicsSceneDiagnostic } from "../src/physics-diagnostics.js";

function sceneWith(
  entities: Array<{ id: string; components: Record<string, unknown> }>,
): SceneDefinition {
  // collectPhysicsSceneDiagnostics only reads entity ids and components.
  return { id: "diag-scene", entities } as unknown as SceneDefinition;
}

test("logPhysicsSceneDiagnostic logs the stable code as a warning with every field a client needs", () => {
  const [diagnostic] = collectPhysicsSceneDiagnostics(
    sceneWith([
      {
        id: "rock",
        components: {
          RigidBody: { type: "fixed" },
          Collider: { shape: "mesh" },
        },
      },
    ]),
  );
  assert.ok(diagnostic, "a mesh collider must produce one diagnostic");

  const entries: Array<{
    level: string;
    message: string;
    data: Record<string, unknown>;
  }> = [];
  logPhysicsSceneDiagnostic((level, message, data) => {
    entries.push({ level, message, data });
  }, diagnostic);

  assert.equal(entries.length, 1);
  const [entry] = entries;
  assert.equal(entry?.level, "warning");
  assert.equal(entry?.message, "physics.unsupportedColliderShape");
  assert.deepEqual(entry?.data, {
    entityId: "rock",
    shape: "mesh",
    source: "Collider.shape",
    bodyType: "fixed",
    fallback: "box",
    message: diagnostic.message,
    remediation: diagnostic.remediation,
  });
  assert.match(String(entry?.data.remediation), /Collider\.shape/);
});

test("logPhysicsSceneDiagnostic reports a dynamic body and a character separately", () => {
  const diagnostics = collectPhysicsSceneDiagnostics(
    sceneWith([
      {
        id: "crate",
        components: { RigidBody: { type: "dynamic" }, Collider: { shape: "convexHull" } },
      },
      {
        id: "hero",
        components: { CharacterBody: {}, Collider: { shape: "box" } },
      },
      { id: "ok", components: { RigidBody: { type: "fixed" }, Collider: { shape: "box" } } },
    ]),
  );
  const levels: string[] = [];
  const bodies: unknown[] = [];
  for (const diagnostic of diagnostics) {
    logPhysicsSceneDiagnostic((level, _message, data) => {
      levels.push(level);
      bodies.push(`${String(data.entityId)}:${String(data.bodyType)}:${String(data.fallback)}`);
    }, diagnostic);
  }
  assert.deepEqual(levels, ["warning", "warning"]);
  assert.deepEqual(bodies, ["crate:dynamic:box", "hero:character:capsule"]);
});
