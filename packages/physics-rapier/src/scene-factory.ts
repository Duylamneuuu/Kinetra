import type { SceneDefinition } from "@kinetra/project-model";

import type { Vec3 } from "./types.js";
import { RapierPhysicsWorld, type RapierPhysicsWorldOptions } from "./world.js";

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : fallback;
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function vec3Value(
  value: unknown,
  fallback: [number, number, number] = [0, 0, 0],
): [number, number, number] {
  if (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((item) => typeof item === "number" && Number.isFinite(item))
  ) {
    return [value[0], value[1], value[2]];
  }
  return fallback;
}

export async function createPhysicsWorldFromScene(
  scene: SceneDefinition,
  options: RapierPhysicsWorldOptions = {},
): Promise<RapierPhysicsWorld> {
  const world = await RapierPhysicsWorld.create(options);
  const initialDynamicStates = new Map<string, Vec3>();

  for (const entity of scene.entities) {
    const transform = asObject(entity.components.Transform);
    const posArray = vec3Value(transform?.position, [0, 0, 0]);
    const position: Vec3 = {
      x: posArray[0],
      y: posArray[1],
      z: posArray[2],
    };

    const rigidBody = asObject(entity.components.RigidBody);
    const collider = asObject(entity.components.Collider);
    const character = asObject(entity.components.CharacterBody);
    const primitive = asObject(entity.components.Primitive);

    if (!rigidBody && !collider && !character) {
      continue;
    }

    const rbType = stringValue(rigidBody?.type, "fixed").toLowerCase();
    const isCharacter =
      Boolean(character) ||
      rbType === "kinematic" ||
      rbType === "kinematicpositionbased";

    if (isCharacter) {
      const radius = numberValue(
        collider?.radius ?? primitive?.radius,
        0.4,
      );
      const halfHeight = numberValue(collider?.halfHeight, 0.5);
      const offset = numberValue(character?.offset, 0.01);
      const autostepMaxHeight =
        typeof character?.autostepMaxHeight === "number"
          ? character.autostepMaxHeight
          : undefined;
      const autostepMinWidth =
        typeof character?.autostepMinWidth === "number"
          ? character.autostepMinWidth
          : undefined;

      world.addKinematicCharacter({
        id: entity.id,
        position,
        halfHeight,
        radius,
        offset,
        ...(autostepMaxHeight !== undefined ? { autostepMaxHeight } : {}),
        ...(autostepMinWidth !== undefined ? { autostepMinWidth } : {}),
      });
      continue;
    }

    if (rbType === "dynamic") {
      const shape = stringValue(
        collider?.shape ?? primitive?.kind,
        "box",
      );
      const restitution =
        typeof collider?.restitution === "number"
          ? collider.restitution
          : undefined;
      const friction =
        typeof collider?.friction === "number" ? collider.friction : undefined;
      const gravityScale =
        typeof rigidBody?.gravityScale === "number"
          ? rigidBody.gravityScale
          : undefined;

      if (shape === "sphere" || shape === "ball") {
        const radius = numberValue(
          collider?.radius ?? primitive?.radius,
          0.5,
        );
        world.addDynamicBody({
          id: entity.id,
          position,
          shape: "sphere",
          radius,
          ...(restitution !== undefined ? { restitution } : {}),
          ...(friction !== undefined ? { friction } : {}),
          ...(gravityScale !== undefined ? { gravityScale } : {}),
        });
      } else if (shape === "capsule") {
        const radius = numberValue(collider?.radius, 0.4);
        const halfHeight = numberValue(collider?.halfHeight, 0.5);
        world.addDynamicBody({
          id: entity.id,
          position,
          shape: "capsule",
          radius,
          halfHeight,
          ...(restitution !== undefined ? { restitution } : {}),
          ...(friction !== undefined ? { friction } : {}),
          ...(gravityScale !== undefined ? { gravityScale } : {}),
        });
      } else {
        let halfExtents: Vec3;
        if (Array.isArray(collider?.halfExtents)) {
          const ext = vec3Value(collider.halfExtents, [0.5, 0.5, 0.5]);
          halfExtents = { x: ext[0], y: ext[1], z: ext[2] };
        } else {
          const size = vec3Value(
            collider?.size ?? primitive?.size,
            [1, 1, 1],
          );
          halfExtents = {
            x: size[0] / 2,
            y: size[1] / 2,
            z: size[2] / 2,
          };
        }

        world.addDynamicBody({
          id: entity.id,
          position,
          shape: "box",
          halfExtents,
          ...(restitution !== undefined ? { restitution } : {}),
          ...(friction !== undefined ? { friction } : {}),
          ...(gravityScale !== undefined ? { gravityScale } : {}),
        });
      }

      initialDynamicStates.set(entity.id, position);
      continue;
    }

    // Default to fixed / static collider
    let halfExtents: Vec3;
    if (Array.isArray(collider?.halfExtents)) {
      const ext = vec3Value(collider.halfExtents, [0.5, 0.5, 0.5]);
      halfExtents = { x: ext[0], y: ext[1], z: ext[2] };
    } else {
      const size = vec3Value(
        collider?.size ?? primitive?.size,
        [1, 1, 1],
      );
      halfExtents = {
        x: size[0] / 2,
        y: size[1] / 2,
        z: size[2] / 2,
      };
    }

    const friction =
      typeof collider?.friction === "number" ? collider.friction : undefined;
    const restitution =
      typeof collider?.restitution === "number"
        ? collider.restitution
        : undefined;

    world.addFixedBox({
      id: entity.id,
      position,
      halfExtents,
      ...(friction !== undefined ? { friction } : {}),
      ...(restitution !== undefined ? { restitution } : {}),
    });
  }

  // Pre-seed spatial query pipeline by stepping once and restoring dynamic positions
  if (world.stats().bodies > 0) {
    world.step();
    for (const [id, pos] of initialDynamicStates) {
      world.setBodyTranslation(id, pos, true);
    }
  }

  return world;
}
