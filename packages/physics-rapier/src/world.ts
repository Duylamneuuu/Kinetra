import RAPIER from "@dimforge/rapier3d-compat";

import type {
  BodyState,
  CharacterMoveResult,
  PhysicsStats,
  Quaternion,
  Vec3,
} from "./types.js";

interface BodyEntry {
  id: string;
  body: RAPIER.RigidBody;
  collider?: RAPIER.Collider;
  isCharacter: boolean;
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
  #controllers = new Map<string, RAPIER.KinematicCharacterController>();
  #accumulator = 0;
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
    if (!(fixedDeltaSeconds > 0)) {
      throw new RangeError("fixedDeltaSeconds must be > 0");
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
  }): void {
    this.#assertNewId(input.id);
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
    this.#bodies.set(input.id, {
      id: input.id,
      body,
      collider,
      isCharacter: false,
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
  }): void {
    this.#assertNewId(input.id);
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
    this.#bodies.set(input.id, {
      id: input.id,
      body,
      collider,
      isCharacter: false,
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
  }): void {
    this.#assertNewId(input.id);
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

    this.#bodies.set(input.id, {
      id: input.id,
      body,
      collider,
      isCharacter: true,
    });
    this.#controllers.set(input.id, controller);
  }

  moveCharacter(id: string, desired: Vec3): CharacterMoveResult {
    const entry = this.#require(id);
    if (!entry.collider) {
      throw new Error(`Body "${id}" has no collider`);
    }

    // Ensure spatial acceleration structure is populated before querying
    if (this.#fixedSteps === 0) {
      this.world.step();
      this.#fixedSteps++;
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

  step(fixedDeltaSeconds?: number): void {
    if (fixedDeltaSeconds !== undefined && fixedDeltaSeconds > 0) {
      this.world.timestep = fixedDeltaSeconds;
    }
    this.world.step();
    this.#fixedSteps++;
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
    entry.body.setTranslation(position, true);
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
    this.world.removeRigidBody(entry.body);
    this.#bodies.delete(id);
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

    try {
      this.world.free();
    } catch {
      // Ignored during dispose
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
      throw new Error(describeUnknownPhysicsBody(id, [...this.#bodies.keys()]));
    }
    return entry;
  }
}

const PHYSICS_ID_LIST_LIMIT = 12;

function describeUnknownPhysicsBody(id: string, ids: readonly string[]): string {
  const sorted = [...new Set(ids.filter((item) => item.length > 0))].sort();
  if (sorted.length === 0) {
    return `Unknown physics body "${id}". No physics bodies exist.`;
  }
  const shown = sorted.slice(0, PHYSICS_ID_LIST_LIMIT);
  const hidden = sorted.length - shown.length;
  const extra = hidden > 0 ? `, and ${hidden} more` : "";
  return `Unknown physics body "${id}". Available bodies: ${shown.join(", ")}${extra}.`;
}
