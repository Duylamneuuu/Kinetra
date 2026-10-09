import RAPIER from "@dimforge/rapier3d-compat";

import {
  MAX_PHYSICS_LAYER,
  type BodyState,
  type CharacterMoveResult,
  type PhysicsHit,
  type PhysicsQueryFilter,
  type PhysicsStats,
  type Quaternion,
  type RaycastQuery,
  type ShapeCastQuery,
  type Vec3,
} from "./types.js";

interface BodyEntry {
  id: string;
  body: RAPIER.RigidBody;
  collider?: RAPIER.Collider;
  isCharacter: boolean;
  /** Query-filter layer (0..31). Does not affect simulation collisions. */
  layer: number;
}

const DEFAULT_QUERY_DISTANCE = 1000;

function assertLayer(layer: number | undefined, label: string): number {
  if (layer === undefined) return 0;
  if (!Number.isInteger(layer) || layer < 0 || layer > MAX_PHYSICS_LAYER) {
    throw new RangeError(
      `${label} must be an integer between 0 and ${MAX_PHYSICS_LAYER}`,
    );
  }
  return layer;
}

function normalizeDirection(direction: Vec3, label: string): Vec3 {
  assertFiniteVec3(direction, label);
  const length = Math.hypot(direction.x, direction.y, direction.z);
  if (!(length > 1e-12) || !Number.isFinite(length)) {
    throw new RangeError(`${label} must be a non-zero vector`);
  }
  return {
    x: direction.x / length,
    y: direction.y / length,
    z: direction.z / length,
  };
}

function cleanZero(value: number): number {
  return value === 0 ? 0 : value;
}

function assertFiniteVec3(value: Vec3, label: string): void {
  if (
    !value ||
    !Number.isFinite(value.x) ||
    !Number.isFinite(value.y) ||
    !Number.isFinite(value.z)
  ) {
    throw new RangeError(`${label} must have finite x, y, z`);
  }
}

let rapierReady: Promise<void> | undefined;

export async function initRapier(): Promise<void> {
  rapierReady ??= RAPIER.init();
  await rapierReady;
}

export interface RapierPhysicsWorldOptions {
  gravity?: Vec3;
  fixedDeltaSeconds?: number;
}

export class RapierPhysicsWorld {
  readonly fixedDeltaSeconds: number;
  readonly world: RAPIER.World;
  #bodies = new Map<string, BodyEntry>();
  #colliderOwners = new Map<number, BodyEntry>();
  #controllers = new Map<string, RAPIER.KinematicCharacterController>();
  #accumulator = 0;
  /** True when colliders moved/appeared/vanished since the broad phase last ran. */
  #queriesStale = true;
  #fixedSteps = 0;

  private constructor(options: {
    gravity: Vec3;
    fixedDeltaSeconds: number;
  }) {
    this.fixedDeltaSeconds = options.fixedDeltaSeconds;
    this.world = new RAPIER.World(options.gravity);
    this.world.timestep = options.fixedDeltaSeconds;
  }

  static async create(
    options: RapierPhysicsWorldOptions = {},
  ): Promise<RapierPhysicsWorld> {
    await initRapier();
    const fixedDeltaSeconds = options.fixedDeltaSeconds ?? 1 / 60;
    if (!Number.isFinite(fixedDeltaSeconds) || fixedDeltaSeconds <= 0) {
      throw new RangeError("fixedDeltaSeconds must be finite and > 0");
    }

    return new RapierPhysicsWorld({
      gravity: options.gravity ?? { x: 0, y: -9.81, z: 0 },
      fixedDeltaSeconds,
    });
  }

  addFixedBox(input: {
    id: string;
    position: Vec3;
    halfExtents: Vec3;
    friction?: number;
    restitution?: number;
    layer?: number;
  }): void {
    this.#assertNewId(input.id);
    const layer = assertLayer(input.layer, "addFixedBox layer");
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(
        input.position.x,
        input.position.y,
        input.position.z,
      ),
    );
    const colDesc = RAPIER.ColliderDesc.cuboid(
      input.halfExtents.x,
      input.halfExtents.y,
      input.halfExtents.z,
    );
    if (input.friction !== undefined) colDesc.setFriction(input.friction);
    if (input.restitution !== undefined)
      colDesc.setRestitution(input.restitution);

    const collider = this.world.createCollider(colDesc, body);
    this.#register({
      id: input.id,
      body,
      collider,
      isCharacter: false,
      layer,
    });
  }

  addDynamicBody(input: {
    id: string;
    position: Vec3;
    shape: "box" | "sphere" | "capsule";
    halfExtents?: Vec3;
    radius?: number;
    halfHeight?: number;
    mass?: number;
    gravityScale?: number;
    restitution?: number;
    friction?: number;
    layer?: number;
  }): void {
    this.#assertNewId(input.id);
    const layer = assertLayer(input.layer, "addDynamicBody layer");
    const bodyDesc = RAPIER.RigidBodyDesc.dynamic().setTranslation(
      input.position.x,
      input.position.y,
      input.position.z,
    );
    if (input.gravityScale !== undefined) {
      bodyDesc.setGravityScale(input.gravityScale);
    }
    const body = this.world.createRigidBody(bodyDesc);

    let colDesc: RAPIER.ColliderDesc;
    switch (input.shape) {
      case "box": {
        const ext = input.halfExtents ?? { x: 0.5, y: 0.5, z: 0.5 };
        colDesc = RAPIER.ColliderDesc.cuboid(ext.x, ext.y, ext.z);
        break;
      }
      case "sphere": {
        const r = input.radius ?? 0.5;
        colDesc = RAPIER.ColliderDesc.ball(r);
        break;
      }
      case "capsule": {
        const hh = input.halfHeight ?? 0.5;
        const r = input.radius ?? 0.5;
        colDesc = RAPIER.ColliderDesc.capsule(hh, r);
        break;
      }
      default:
        throw new Error(`Unsupported dynamic body shape "${input.shape}"`);
    }

    if (input.restitution !== undefined)
      colDesc.setRestitution(input.restitution);
    if (input.friction !== undefined) colDesc.setFriction(input.friction);
    if (input.mass !== undefined) colDesc.setMass(input.mass);

    const collider = this.world.createCollider(colDesc, body);
    this.#register({
      id: input.id,
      body,
      collider,
      isCharacter: false,
      layer,
    });
  }

  addKinematicCharacter(input: {
    id: string;
    position: Vec3;
    halfHeight: number;
    radius: number;
    offset?: number;
    autostepMaxHeight?: number;
    autostepMinWidth?: number;
    layer?: number;
  }): void {
    this.#assertNewId(input.id);
    const layer = assertLayer(input.layer, "addKinematicCharacter layer");
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(
        input.position.x,
        input.position.y,
        input.position.z,
      ),
    );
    const collider = this.world.createCollider(
      RAPIER.ColliderDesc.capsule(input.halfHeight, input.radius),
      body,
    );

    const offset = input.offset ?? 0.01;
    const controller = this.world.createCharacterController(offset);
    controller.setUp({ x: 0, y: 1, z: 0 });
    controller.setSlideEnabled(true);
    controller.setMaxSlopeClimbAngle((45 * Math.PI) / 180);
    controller.setMinSlopeSlideAngle((30 * Math.PI) / 180);

    if (input.autostepMaxHeight && input.autostepMinWidth) {
      controller.enableAutostep(
        input.autostepMaxHeight,
        input.autostepMinWidth,
        false,
      );
    }

    this.#register({
      id: input.id,
      body,
      collider,
      isCharacter: true,
      layer,
    });
    this.#controllers.set(input.id, controller);
  }

  moveCharacter(id: string, desired: Vec3): CharacterMoveResult {
    const entry = this.#require(id);
    if (!entry.collider) {
      throw new Error(`Body "${id}" has no collider`);
    }
    assertFiniteVec3(desired, "moveCharacter desired");

    // Ensure spatial acceleration structure is populated before querying
    if (this.#fixedSteps === 0) {
      this.world.step();
      this.#fixedSteps++;
      this.#queriesStale = false;
    }

    let controller = this.#controllers.get(id);
    if (!controller) {
      controller = this.world.createCharacterController(0.01);
      controller.setUp({ x: 0, y: 1, z: 0 });
      controller.setSlideEnabled(true);
      this.#controllers.set(id, controller);
    }

    controller.computeColliderMovement(entry.collider, desired);
    const computed = controller.computedMovement();
    const current = entry.body.translation();
    const next = {
      x: current.x + computed.x,
      y: current.y + computed.y,
      z: current.z + computed.z,
    };

    entry.body.setNextKinematicTranslation(next);
    entry.body.setTranslation(next, true);
    this.#queriesStale = true;

    const collided =
      Math.abs(computed.x - desired.x) > 1e-4 ||
      Math.abs(computed.y - desired.y) > 1e-4 ||
      Math.abs(computed.z - desired.z) > 1e-4;

    return {
      requested: desired,
      actual: { x: computed.x, y: computed.y, z: computed.z },
      collided,
    };
  }

  /**
   * Runs exactly one simulation step. An explicit `fixedDeltaSeconds` applies to this
   * step only: the world's configured fixed timestep is restored afterwards so later
   * `advance()` calls keep integrating `this.fixedDeltaSeconds` per step.
   */
  step(fixedDeltaSeconds?: number): void {
    if (fixedDeltaSeconds === undefined) {
      this.world.step();
      this.#fixedSteps++;
      this.#queriesStale = false;
      return;
    }
    if (!Number.isFinite(fixedDeltaSeconds) || fixedDeltaSeconds <= 0) {
      throw new RangeError("fixedDeltaSeconds must be finite and > 0");
    }
    this.world.timestep = fixedDeltaSeconds;
    try {
      this.world.step();
      this.#fixedSteps++;
      this.#queriesStale = false;
    } finally {
      this.world.timestep = this.fixedDeltaSeconds;
    }
  }

  advance(realDeltaSeconds: number): number {
    if (!Number.isFinite(realDeltaSeconds) || realDeltaSeconds < 0) {
      throw new RangeError("realDeltaSeconds must be finite and non-negative");
    }

    // Clamp accumulator to protect against giant pause spikes
    this.#accumulator += Math.min(realDeltaSeconds, 0.25);
    let steps = 0;

    while (this.#accumulator + Number.EPSILON >= this.fixedDeltaSeconds) {
      this.world.step();
      this.#accumulator -= this.fixedDeltaSeconds;
      this.#fixedSteps++;
      this.#queriesStale = false;
      steps++;
    }

    return steps;
  }

  state(id: string): BodyState {
    const body = this.#require(id).body;
    const p = body.translation();
    const q = body.rotation();
    const v = body.linvel();

    if (
      !Number.isFinite(p.x) ||
      !Number.isFinite(p.y) ||
      !Number.isFinite(p.z) ||
      !Number.isFinite(q.x) ||
      !Number.isFinite(q.y) ||
      !Number.isFinite(q.z) ||
      !Number.isFinite(q.w) ||
      !Number.isFinite(v.x) ||
      !Number.isFinite(v.y) ||
      !Number.isFinite(v.z)
    ) {
      throw new Error(
        `Physics body "${id}" contains non-finite numbers (NaN/Infinity)`,
      );
    }

    return {
      id,
      position: { x: p.x, y: p.y, z: p.z },
      rotation: { x: q.x, y: q.y, z: q.z, w: q.w },
      linearVelocity: { x: v.x, y: v.y, z: v.z },
    };
  }

  setBodyTranslation(
    id: string,
    position: Vec3,
    resetVelocity = false,
  ): void {
    const entry = this.#require(id);
    assertFiniteVec3(position, "setBodyTranslation position");
    entry.body.setTranslation(position, true);
    this.#queriesStale = true;
    if (resetVelocity) {
      entry.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      entry.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
  }

  hasBody(id: string): boolean {
    return this.#bodies.has(id);
  }

  bodyIds(): string[] {
    return [...this.#bodies.keys()];
  }

  characterIds(): string[] {
    const result: string[] = [];
    for (const [id, entry] of this.#bodies.entries()) {
      if (entry.isCharacter) {
        result.push(id);
      }
    }
    return result;
  }

  stats(): PhysicsStats {
    return {
      bodies: this.world.bodies.len(),
      colliders: this.world.colliders.len(),
      fixedSteps: this.#fixedSteps,
      accumulatorSeconds: this.#accumulator,
    };
  }

  remove(id: string): void {
    const entry = this.#require(id);
    const controller = this.#controllers.get(id);
    if (controller) {
      this.world.removeCharacterController(controller);
      this.#controllers.delete(id);
    }
    if (entry.collider) this.#colliderOwners.delete(entry.collider.handle);
    this.world.removeRigidBody(entry.body);
    this.#bodies.delete(id);
    this.#queriesStale = true;
  }

  dispose(): void {
    for (const controller of this.#controllers.values()) {
      try {
        this.world.removeCharacterController(controller);
      } catch {
        // Ignored during dispose
      }
    }
    this.#controllers.clear();
    this.#bodies.clear();
    this.#colliderOwners.clear();

    try {
      this.world.free();
    } catch {
      // Ignored during dispose
    }
  }

  /**
   * Closest hit of a ray against the world, filtered by layer / excluded entities.
   * Read-only: it never steps or mutates the simulation, and it is deterministic for a given
   * world state. Returns `null` when nothing is hit within `maxDistance`.
   */
  raycast(query: RaycastQuery): PhysicsHit | null {
    assertFiniteVec3(query.origin, "raycast origin");
    const direction = normalizeDirection(query.direction, "raycast direction");
    const maxDistance = this.#queryDistance(query, "raycast");
    const predicate = this.#queryPredicate(query);
    if (!predicate) return null;
    this.#refreshQueries();

    const hit = this.world.castRayAndGetNormal(
      new RAPIER.Ray(query.origin, direction),
      maxDistance,
      true,
      undefined,
      undefined,
      undefined,
      undefined,
      predicate,
    );
    if (!hit) return null;
    const owner = this.#colliderOwners.get(hit.collider.handle);
    if (!owner) return null;

    const distance = hit.timeOfImpact;
    const startedInside = distance <= 0;
    const rawNormal = hit.normal;
    const normalLength = Math.hypot(rawNormal.x, rawNormal.y, rawNormal.z);
    const normal =
      startedInside || !(normalLength > 0)
        ? { x: -direction.x, y: -direction.y, z: -direction.z }
        : {
            x: rawNormal.x / normalLength,
            y: rawNormal.y / normalLength,
            z: rawNormal.z / normalLength,
          };
    return {
      entityId: owner.id,
      point: {
        x: cleanZero(query.origin.x + direction.x * distance),
        y: cleanZero(query.origin.y + direction.y * distance),
        z: cleanZero(query.origin.z + direction.z * distance),
      },
      normal: {
        x: cleanZero(normal.x),
        y: cleanZero(normal.y),
        z: cleanZero(normal.z),
      },
      distance: Math.max(0, distance),
      startedInside,
    };
  }

  /**
   * Sweeps a sphere, box or capsule along `direction` and returns the first contact. Same
   * read-only / deterministic guarantees as `raycast`. `distance` is accurate to ~1e-4; the
   * contact `point` comes from Rapier's iterative time-of-impact solver and is accurate to
   * roughly 3e-3 world units.
   */
  shapeCast(query: ShapeCastQuery): PhysicsHit | null {
    assertFiniteVec3(query.origin, "shapeCast origin");
    const direction = normalizeDirection(query.direction, "shapeCast direction");
    const maxDistance = this.#queryDistance(query, "shapeCast");
    const rotation = query.rotation ?? { x: 0, y: 0, z: 0, w: 1 };
    if (
      !Number.isFinite(rotation.x) ||
      !Number.isFinite(rotation.y) ||
      !Number.isFinite(rotation.z) ||
      !Number.isFinite(rotation.w) ||
      Math.abs(
        Math.hypot(rotation.x, rotation.y, rotation.z, rotation.w) - 1,
      ) > 1e-3
    ) {
      throw new RangeError("shapeCast rotation must be a finite unit quaternion");
    }
    const shape = this.#buildCastShape(query.shape);
    const predicate = this.#queryPredicate(query);
    if (!predicate) return null;
    this.#refreshQueries();

    const hit = this.world.castShape(
      query.origin,
      rotation,
      direction,
      shape,
      0,
      maxDistance,
      true,
      undefined,
      undefined,
      undefined,
      undefined,
      predicate,
    );
    if (!hit) return null;
    const owner = this.#colliderOwners.get(hit.collider.handle);
    if (!owner) return null;

    const distance = Math.max(0, hit.time_of_impact);
    const startedInside = distance <= 1e-9;
    // Rapier reports the contact point and outward normal of the hit collider in world space.
    const witness = hit.witness1;
    const worldNormal = hit.normal1;
    const normalLength = Math.hypot(worldNormal.x, worldNormal.y, worldNormal.z);
    const normal =
      startedInside || !(normalLength > 0)
        ? { x: -direction.x, y: -direction.y, z: -direction.z }
        : {
            x: worldNormal.x / normalLength,
            y: worldNormal.y / normalLength,
            z: worldNormal.z / normalLength,
          };
    return {
      entityId: owner.id,
      point: {
        x: cleanZero(witness.x),
        y: cleanZero(witness.y),
        z: cleanZero(witness.z),
      },
      normal: {
        x: cleanZero(normal.x),
        y: cleanZero(normal.y),
        z: cleanZero(normal.z),
      },
      distance,
      startedInside,
    };
  }

  /** Query-filter layer of a body (0 unless assigned). */
  layerOf(id: string): number {
    return this.#require(id).layer;
  }

  #register(entry: BodyEntry): void {
    this.#queriesStale = true;
    this.#bodies.set(entry.id, entry);
    if (entry.collider) this.#colliderOwners.set(entry.collider.handle, entry);
  }

  /**
   * Rapier only (re)builds its broad phase inside `step()`. When something changed since the
   * last step, run a zero-timestep step: it refreshes the spatial structures used by queries
   * without integrating bodies, advancing time, or touching `stats().fixedSteps`.
   */
  #refreshQueries(): void {
    if (!this.#queriesStale) return;
    this.world.timestep = 0;
    try {
      this.world.step();
    } finally {
      this.world.timestep = this.fixedDeltaSeconds;
    }
    this.#queriesStale = false;
  }

  #queryDistance(query: PhysicsQueryFilter, label: string): number {
    const maxDistance = query.maxDistance ?? DEFAULT_QUERY_DISTANCE;
    if (!Number.isFinite(maxDistance) || maxDistance <= 0) {
      throw new RangeError(`${label} maxDistance must be finite and > 0`);
    }
    return maxDistance;
  }

  /** Returns `undefined` when the filter can never match anything (empty layer list). */
  #queryPredicate(
    query: PhysicsQueryFilter,
  ): ((collider: RAPIER.Collider) => boolean) | undefined {
    let layerSet: Set<number> | undefined;
    if (query.layers !== undefined) {
      if (!Array.isArray(query.layers)) {
        throw new TypeError("query layers must be an array of integers");
      }
      layerSet = new Set<number>();
      for (const layer of query.layers) {
        layerSet.add(assertLayer(layer, "query layer"));
      }
      if (layerSet.size === 0) return undefined;
    }
    const excluded = new Set<string>(query.excludeEntityIds ?? []);
    return (collider) => {
      const owner = this.#colliderOwners.get(collider.handle);
      if (!owner) return false;
      if (layerSet && !layerSet.has(owner.layer)) return false;
      return !excluded.has(owner.id);
    };
  }

  #buildCastShape(shape: ShapeCastQuery["shape"]): RAPIER.Shape {
    const positive = (value: number, label: string): number => {
      if (!Number.isFinite(value) || value <= 0) {
        throw new RangeError(`shapeCast ${label} must be finite and > 0`);
      }
      return value;
    };
    switch (shape?.type) {
      case "sphere":
        return new RAPIER.Ball(positive(shape.radius, "sphere radius"));
      case "box": {
        assertFiniteVec3(shape.halfExtents, "shapeCast box halfExtents");
        return new RAPIER.Cuboid(
          positive(shape.halfExtents.x, "box halfExtents.x"),
          positive(shape.halfExtents.y, "box halfExtents.y"),
          positive(shape.halfExtents.z, "box halfExtents.z"),
        );
      }
      case "capsule":
        return new RAPIER.Capsule(
          positive(shape.halfHeight, "capsule halfHeight"),
          positive(shape.radius, "capsule radius"),
        );
      default:
        throw new RangeError(
          "shapeCast shape.type must be sphere, box or capsule",
        );
    }
  }

  #assertNewId(id: string): void {
    if (this.#bodies.has(id)) {
      throw new Error(`Physics body "${id}" already exists`);
    }
  }

  #require(id: string): BodyEntry {
    const entry = this.#bodies.get(id);
    if (!entry) {
      throw new Error(`Unknown physics body "${id}"`);
    }
    return entry;
  }
}
