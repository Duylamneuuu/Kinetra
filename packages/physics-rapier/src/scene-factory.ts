import type { SceneDefinition } from "@kinetra/project-model";

import { MAX_PHYSICS_LAYER, type Quaternion, type Vec3 } from "./types.js";
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

/**
 * Quaternion for a `Transform.rotation` (Euler XYZ radians, the order the render runtime applies
 * with `object.rotation.set`). `undefined` for identity, so unrotated bodies are built exactly as
 * before.
 */
function rotationQuaternion(value: unknown): Quaternion | undefined {
  const [x, y, z] = vec3Value(value, [0, 0, 0]);
  if (x === 0 && y === 0 && z === 0) return undefined;
  const c1 = Math.cos(x / 2);
  const c2 = Math.cos(y / 2);
  const c3 = Math.cos(z / 2);
  const s1 = Math.sin(x / 2);
  const s2 = Math.sin(y / 2);
  const s3 = Math.sin(z / 2);
  const q = {
    x: s1 * c2 * c3 + c1 * s2 * s3,
    y: c1 * s2 * c3 - s1 * c2 * s3,
    z: c1 * c2 * s3 + s1 * s2 * c3,
    w: c1 * c2 * c3 - s1 * s2 * s3,
  };
  // Already unit up to rounding; normalise so the world's unit-quaternion check never trips.
  const length = Math.hypot(q.x, q.y, q.z, q.w);
  return { x: q.x / length, y: q.y / length, z: q.z / length, w: q.w / length };
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

/**
 * How one scene entity's physics body is built. This is the single decision point shared by
 * `populateWorld` (which builds the body) and `diagnoseEntity` (which reports what was
 * substituted), so the two can no longer disagree about which shape an entity ends up with.
 */
export interface ColliderPlan {
  /** `kinematic` is a non-character kinematic body; `character` has a CharacterBody component. */
  readonly bodyType: "fixed" | "dynamic" | "kinematic" | "character";
  /** The shape actually built (`ball` is normalised to `sphere`). */
  readonly shape: "box" | "sphere" | "capsule";
  /** Set when the declared shape was not built as authored; `shape` is then the fallback. */
  readonly unsupported?: {
    /** The declared value, stringified (`7` for a non-string shape). */
    readonly shape: string;
    readonly source: PhysicsSceneDiagnostic["source"];
  };
}

/** The body an entity gets in the physics world, or `undefined` when it has no physics components. */
export function resolveColliderPlan(
  entity: SceneDefinition["entities"][number],
): ColliderPlan | undefined {
  const rigidBody = asObject(entity.components.RigidBody);
  const collider = asObject(entity.components.Collider);
  const character = asObject(entity.components.CharacterBody);
  const primitive = asObject(entity.components.Primitive);
  if (!rigidBody && !collider && !character) return undefined;

  const declared = declaredShapeOf(collider, primitive);
  const declaredText = declared ? String(declared.value) : "";

  const rbType = stringValue(rigidBody?.type, "fixed").toLowerCase();
  // Every kinematic flavour declared by RigidBodyType is driven through the character
  // controller; "kinematicVelocityBased" used to fall through to a fixed box.
  const isCharacter =
    Boolean(character) ||
    rbType === "kinematic" ||
    rbType === "kinematicpositionbased" ||
    rbType === "kinematicvelocitybased";

  if (isCharacter) {
    // A kinematic body that declares a box/sphere collider (a moving platform, a door) and is not
    // a CharacterBody must keep that shape; only capsule / undeclared shapes are character bodies.
    if (!character && (declaredText === "box" || declaredText === "sphere" || declaredText === "ball")) {
      return { bodyType: "kinematic", shape: declaredText === "box" ? "box" : "sphere" };
    }
    const bodyType = character ? "character" : "kinematic";
    // A character is always a capsule; a Primitive kind is only the render mesh, so only an
    // explicit non-capsule Collider.shape is a mismatch worth reporting.
    if (declared && declared.source === "Collider.shape" && declaredText !== "capsule") {
      return { bodyType, shape: "capsule", unsupported: { shape: declaredText, source: declared.source } };
    }
    return { bodyType, shape: "capsule" };
  }

  const bodyType = rbType === "dynamic" ? "dynamic" : "fixed";
  const shape: ColliderPlan["shape"] =
    declaredText === "sphere" || declaredText === "ball"
      ? "sphere"
      : declaredText === "capsule"
        ? "capsule"
        : "box";
  if (!declared) return { bodyType, shape };
  if (typeof declared.value === "string" && SUPPORTED_SHAPES.has(declaredText)) return { bodyType, shape };
  // A plane Primitive is built as a box from Primitive.size (its render mesh is a thin box too).
  if (declared.source === "Primitive.kind" && declaredText === "plane") return { bodyType, shape };
  return { bodyType, shape: "box", unsupported: { shape: declaredText, source: declared.source } };
}

function diagnoseEntity(entity: SceneDefinition["entities"][number]): PhysicsSceneDiagnostic | undefined {
  const plan = resolveColliderPlan(entity);
  if (!plan?.unsupported) return undefined;
  const { shape, source } = plan.unsupported;
  const { bodyType } = plan;
  const fallback = plan.shape as PhysicsSceneDiagnostic["fallback"];

  return {
    code: "physics.unsupportedColliderShape",
    severity: "warning",
    entityId: entity.id,
    shape,
    source,
    bodyType,
    fallback,
    message: `Entity "${entity.id}" declares ${source} "${shape}", which the ${bodyType} physics path does not support; a ${fallback} collider was built instead.`,
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

    // Authored orientation. A character capsule keeps identity: its facing is owned by the render
    // object (root motion / scripts), and the player never copies a character's rotation back.
    const orientation = rotationQuaternion(transform?.rotation);
    const rotationOption = orientation ? { rotation: orientation } : {};

    const rigidBody = asObject(entity.components.RigidBody);
    const collider = asObject(entity.components.Collider);
    const character = asObject(entity.components.CharacterBody);
    const primitive = asObject(entity.components.Primitive);
    const layer = layerValue(collider?.layer);
    const layerOption = layer !== undefined ? { layer } : {};

    // One shared decision (see resolveColliderPlan) so the world and the diagnostics agree.
    const plan = resolveColliderPlan(entity);
    if (!plan) {
      continue;
    }

    if (plan.bodyType === "kinematic" && plan.shape !== "capsule") {
      const friction =
        typeof collider?.friction === "number" ? collider.friction : undefined;
      const restitution =
        typeof collider?.restitution === "number"
          ? collider.restitution
          : undefined;
      const common = {
        id: entity.id,
        position,
        ...rotationOption,
        ...(friction !== undefined ? { friction } : {}),
        ...(restitution !== undefined ? { restitution } : {}),
        ...layerOption,
      };
      if (plan.shape === "box") {
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

    if (plan.bodyType === "kinematic" || plan.bodyType === "character") {
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

    if (plan.bodyType === "dynamic") {
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

      if (plan.shape === "sphere") {
        const radius = numberValue(
          collider?.radius ?? primitive?.radius,
          0.5,
        );
        world.addDynamicBody({
          id: entity.id,
          position,
          ...rotationOption,
          shape: "sphere",
          radius,
          ...(restitution !== undefined ? { restitution } : {}),
          ...(friction !== undefined ? { friction } : {}),
          ...(gravityScale !== undefined ? { gravityScale } : {}),
          ...massOption,
          ...layerOption,
        });
      } else if (plan.shape === "capsule") {
        const radius = numberValue(collider?.radius, 0.4);
        const halfHeight = numberValue(collider?.halfHeight, 0.5);
        world.addDynamicBody({
          id: entity.id,
          position,
          ...rotationOption,
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
          ...rotationOption,
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
    if (plan.shape === "sphere" || plan.shape === "capsule") {
      const fixedFriction =
        typeof collider?.friction === "number" ? collider.friction : undefined;
      const fixedRestitution =
        typeof collider?.restitution === "number"
          ? collider.restitution
          : undefined;
      const fixedCommon = {
        id: entity.id,
        position,
        ...rotationOption,
        ...(fixedFriction !== undefined ? { friction: fixedFriction } : {}),
        ...(fixedRestitution !== undefined ? { restitution: fixedRestitution } : {}),
        ...layerOption,
      };
      if (plan.shape === "capsule") {
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
      ...rotationOption,
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
