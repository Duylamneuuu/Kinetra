import type { SceneDefinition } from "@kinetra/project-model";

import { MAX_PHYSICS_LAYER, type Vec3 } from "./types.js";
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

/** Query-filter layer from a Collider component; invalid values fall back to the default layer. */
function layerValue(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_PHYSICS_LAYER
    ? value
    : undefined;
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

/** Collider shapes the scene factory builds as declared. */
export const SUPPORTED_COLLIDER_SHAPES = ["box", "sphere", "ball", "capsule"] as const;

/**
 * A scene entity whose physics could not be built exactly as authored. The world is still built
 * (with `fallback` in place of the declared shape) so existing scenes keep loading, but the caller
 * gets a structured, stable code to log or surface instead of a silent substitution.
 */
export interface PhysicsSceneDiagnostic {
  readonly code: "physics.unsupportedColliderShape";
  readonly severity: "warning";
  readonly entityId: string;
  /** The declared value, stringified (`7` for a non-string shape). */
  readonly shape: string;
  readonly source: "Collider.shape" | "Primitive.kind";
  readonly bodyType: "fixed" | "dynamic" | "kinematic" | "character";
  /** The shape actually built in its place. */
  readonly fallback: "box" | "capsule";
  readonly message: string;
  readonly remediation: string;
}

export interface PhysicsSceneFactoryOptions extends RapierPhysicsWorldOptions {
  /** Called once per entity whose collider could not be built as authored. Errors it throws are ignored. */
  onDiagnostic?: (diagnostic: PhysicsSceneDiagnostic) => void;
}

const SUPPORTED_SHAPES = new Set<string>(SUPPORTED_COLLIDER_SHAPES);

function declaredShapeOf(
  collider: Record<string, unknown> | null,
  primitive: Record<string, unknown> | null,
): { value: unknown; source: PhysicsSceneDiagnostic["source"] } | undefined {
  // Mirrors `collider?.shape ?? primitive?.kind` below: an empty string counts as undeclared,
  // exactly as stringValue() treats it.
  const pick = (value: unknown) => value !== undefined && value !== null && value !== "";
  if (collider && pick(collider.shape)) return { value: collider.shape, source: "Collider.shape" };
  if (collider && collider.shape !== undefined && collider.shape !== null) return undefined;
  if (primitive && pick(primitive.kind)) return { value: primitive.kind, source: "Primitive.kind" };
  return undefined;
}

function diagnoseEntity(entity: SceneDefinition["entities"][number]): PhysicsSceneDiagnostic | undefined {
  const rigidBody = asObject(entity.components.RigidBody);
  const collider = asObject(entity.components.Collider);
  const character = asObject(entity.components.CharacterBody);
  const primitive = asObject(entity.components.Primitive);
  if (!rigidBody && !collider && !character) return undefined;

  const declared = declaredShapeOf(collider, primitive);
  if (!declared) return undefined;
  const shape = String(declared.value);

  const rbType = stringValue(rigidBody?.type, "fixed").toLowerCase();
  const isCharacter =
    Boolean(character) ||
    rbType === "kinematic" ||
    rbType === "kinematicpositionbased" ||
    rbType === "kinematicvelocitybased";

  let bodyType: PhysicsSceneDiagnostic["bodyType"];
  let fallback: PhysicsSceneDiagnostic["fallback"];
  if (isCharacter) {
    if (!character && (shape === "box" || shape === "sphere" || shape === "ball")) return undefined;
    // A character is always a capsule; a Primitive kind is only the render mesh, so only an
    // explicit non-capsule Collider.shape is a mismatch worth reporting.
    if (declared.source !== "Collider.shape" || shape === "capsule") return undefined;
    bodyType = character ? "character" : "kinematic";
    fallback = "capsule";
  } else {
    if (typeof declared.value === "string" && SUPPORTED_SHAPES.has(shape)) return undefined;
    // A plane Primitive is built as a box from Primitive.size (its render mesh is a thin box too).
    if (declared.source === "Primitive.kind" && shape === "plane") return undefined;
    bodyType = rbType === "dynamic" ? "dynamic" : "fixed";
    fallback = "box";
  }

  return {
    code: "physics.unsupportedColliderShape",
    severity: "warning",
    entityId: entity.id,
    shape,
    source: declared.source,
    bodyType,
    fallback,
    message: `Entity "${entity.id}" declares ${declared.source} "${shape}", which the ${bodyType} physics path does not support; a ${fallback} collider was built instead.`,
    remediation:
      bodyType === "character"
        ? `CharacterBody colliders are capsules: set Collider.shape to "capsule" (radius, halfHeight) or remove it.`
        : `Use a supported Collider.shape (${SUPPORTED_COLLIDER_SHAPES.join(", ")}), sized with size/halfExtents, radius or radius+halfHeight.`,
  };
}

/** Every collider in `scene` that would not be built as authored, without creating a physics world. */
export function collectPhysicsSceneDiagnostics(scene: SceneDefinition): PhysicsSceneDiagnostic[] {
  const diagnostics: PhysicsSceneDiagnostic[] = [];
  for (const entity of scene.entities) {
    const diagnostic = diagnoseEntity(entity);
    if (diagnostic) diagnostics.push(diagnostic);
  }
  return diagnostics;
}

export async function createPhysicsWorldFromScene(
  scene: SceneDefinition,
  options: PhysicsSceneFactoryOptions = {},
): Promise<RapierPhysicsWorld> {
  const { onDiagnostic, ...worldOptions } = options;
  const world = await RapierPhysicsWorld.create(worldOptions);
  try {
    populateWorld(world, scene);
  } catch (error) {
    // Do not leak the WASM world when one entity is rejected.
    world.dispose();
    throw error;
  }
  if (onDiagnostic) {
    for (const diagnostic of collectPhysicsSceneDiagnostics(scene)) {
      try {
        onDiagnostic(diagnostic);
      } catch {
        // A broken logger must not take the physics world (or the scene start) down with it.
      }
    }
  }
  return world;
}

function populateWorld(world: RapierPhysicsWorld, scene: SceneDefinition): void {
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
    const layer = layerValue(collider?.layer);
    const layerOption = layer !== undefined ? { layer } : {};

    if (!rigidBody && !collider && !character) {
      continue;
    }

    const rbType = stringValue(rigidBody?.type, "fixed").toLowerCase();
    // Every kinematic flavour declared by RigidBodyType is driven through the character
    // controller; "kinematicVelocityBased" used to fall through to a fixed box.
    const isCharacter =
      Boolean(character) ||
      rbType === "kinematic" ||
      rbType === "kinematicpositionbased" ||
      rbType === "kinematicvelocitybased";

    // A kinematic body that declares a box/sphere collider (a moving platform, a door) and is not
    // a CharacterBody must keep that shape; only capsule / undeclared shapes are character bodies.
    const declaredShape = stringValue(collider?.shape ?? primitive?.kind, "");
    if (
      isCharacter &&
      !character &&
      (declaredShape === "box" || declaredShape === "sphere" || declaredShape === "ball")
    ) {
      const friction =
        typeof collider?.friction === "number" ? collider.friction : undefined;
      const restitution =
        typeof collider?.restitution === "number"
          ? collider.restitution
          : undefined;
      const common = {
        id: entity.id,
        position,
        ...(friction !== undefined ? { friction } : {}),
        ...(restitution !== undefined ? { restitution } : {}),
        ...layerOption,
      };
      if (declaredShape === "box") {
        let halfExtents: Vec3;
        if (Array.isArray(collider?.halfExtents)) {
          const ext = vec3Value(collider.halfExtents, [0.5, 0.5, 0.5]);
          halfExtents = { x: ext[0], y: ext[1], z: ext[2] };
        } else {
          const size = vec3Value(collider?.size ?? primitive?.size, [1, 1, 1]);
          halfExtents = { x: size[0] / 2, y: size[1] / 2, z: size[2] / 2 };
        }
        world.addKinematicBody({ ...common, shape: "box", halfExtents });
      } else {
        world.addKinematicBody({
          ...common,
          shape: "sphere",
          radius: numberValue(collider?.radius ?? primitive?.radius, 0.5),
        });
      }
      continue;
    }

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
        ...layerOption,
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
      // RigidBodyComponent.mass was declared but never forwarded to the collider.
      // A present-but-invalid mass is rejected by addDynamicBody (RangeError), like gravityScale.
      const mass =
        typeof rigidBody?.mass === "number" ? rigidBody.mass : undefined;
      const massOption = mass !== undefined ? { mass } : {};

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
          ...massOption,
          ...layerOption,
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
          ...massOption,
          ...layerOption,
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
          ...massOption,
          ...layerOption,
        });
      }

      initialDynamicStates.set(entity.id, position);
      continue;
    }

    // Default to fixed / static collider. A declared sphere or capsule keeps its shape; the fixed
    // path used to build a (default 1x1x1) cuboid whatever the Collider / Primitive declared.
    const fixedShape = stringValue(collider?.shape ?? primitive?.kind, "box");
    if (fixedShape === "sphere" || fixedShape === "ball" || fixedShape === "capsule") {
      const fixedFriction =
        typeof collider?.friction === "number" ? collider.friction : undefined;
      const fixedRestitution =
        typeof collider?.restitution === "number"
          ? collider.restitution
          : undefined;
      const fixedCommon = {
        id: entity.id,
        position,
        ...(fixedFriction !== undefined ? { friction: fixedFriction } : {}),
        ...(fixedRestitution !== undefined ? { restitution: fixedRestitution } : {}),
        ...layerOption,
      };
      if (fixedShape === "capsule") {
        world.addFixedCapsule({
          ...fixedCommon,
          radius: numberValue(collider?.radius, 0.4),
          halfHeight: numberValue(collider?.halfHeight, 0.5),
        });
      } else {
        world.addFixedSphere({
          ...fixedCommon,
          radius: numberValue(collider?.radius ?? primitive?.radius, 0.5),
        });
      }
      continue;
    }

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
      ...layerOption,
    });
  }

  // Pre-seed spatial query pipeline by stepping once and restoring dynamic positions
  if (world.stats().bodies > 0) {
    world.step();
    for (const [id, pos] of initialDynamicStates) {
      world.setBodyTranslation(id, pos, true);
    }
  }
}
