import {
  assertValidProject,
  type ProjectDocument,
} from "@kinetra/project-model";
import {
  createPhysicsWorldFromScene,
  RapierPhysicsWorld,
} from "@kinetra/physics-rapier";
import { RecastNavMesh } from "@kinetra/navigation-recast";
import { ThreeSceneRuntime, type AssetResolver } from "@kinetra/renderer-three";
import * as THREE from "three";

export type PlayerRuntimeLogLevel = "debug" | "info" | "warning" | "error";

export interface PlayerRuntimeLog {
  sequence: number;
  level: PlayerRuntimeLogLevel;
  message: string;
  data?: Record<string, unknown>;
}

export interface PlayerRuntimeQuery {
  entityIds?: string[];
}

export interface PlayerRuntimeModelAnimationState {
  clips: Array<{ name: string; duration: number }>;
  activeClip?: string;
  playing: boolean;
  time: number;
  duration?: number;
}

export interface PlayerRuntimeModelNodeState {
  name: string;
  position: [number, number, number];
  rotation?: [number, number, number, number];
  scale?: [number, number, number];
}

export interface PlayerRuntimeModelState {
  assetId: string;
  loaded: boolean;
  meshCount: number;
  nodeCount: number;
  bounds?: {
    min: [number, number, number];
    max: [number, number, number];
    size: [number, number, number];
  };
  animation?: PlayerRuntimeModelAnimationState;
  nodes?: PlayerRuntimeModelNodeState[];
  error?: string;
}

export interface PlayerRuntimeEntityState {
  entityId: string;
  name: string;
  objectType: string;
  parentEntityId?: string;
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
  model?: PlayerRuntimeModelState;
}

export interface PlayerRuntimeNavigationState {
  hasNavMesh: boolean;
  lastClosestPoint?: {
    point: [number, number, number];
  };
  lastPath?: {
    success: boolean;
    status: "complete" | "failed" | "partial";
    pointCount: number;
    points: Array<[number, number, number]>;
  };
  serialized?: string;
}

export interface PlayerRuntimeQueryResult {
  running: boolean;
  sceneId?: string;
  projectRevision?: number;
  entities: PlayerRuntimeEntityState[];
  navigation?: PlayerRuntimeNavigationState;
}

export interface PlayerRuntimeInput {
  action: string;
  phase: "press" | "release" | "hold";
  value?: number | [number, number];
  durationMs?: number;
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export class PlayerRuntimeController {
  readonly renderer: THREE.WebGLRenderer;

  #runtime: ThreeSceneRuntime | undefined;
  #physics: RapierPhysicsWorld | undefined;
  #navMesh: RecastNavMesh | undefined;
  #navigationState: PlayerRuntimeNavigationState = { hasNavMesh: false };
  #assetResolver: AssetResolver;
  #assetRegistry = new Map<string, Uint8Array>();
  #camera: THREE.Camera;
  #projectRevision: number | undefined;
  #logs: PlayerRuntimeLog[] = [];
  #nextLogSequence = 1;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    this.#assetResolver = {
      resolve: (assetId: string) => {
        return this.#assetRegistry.get(assetId);
      },
    };

    this.#camera = this.#createFallbackCamera();
    window.addEventListener("resize", () => this.resize());
    this.resize();
  }

  registerAsset(assetId: string, data: Uint8Array | string): void {
    const bytes = typeof data === "string" ? base64ToUint8Array(data) : data;
    this.#assetRegistry.set(assetId, bytes);
    this.#log("debug", "asset.registered", {
      assetId,
      byteLength: bytes.byteLength,
    });
  }

  async start(
    project: ProjectDocument,
    sceneId: string,
    projectRevision: number,
    options?: { assets?: Record<string, string> },
  ): Promise<PlayerRuntimeQueryResult> {
    assertValidProject(project);
    this.stop();

    if (options?.assets) {
      for (const [assetId, base64] of Object.entries(options.assets)) {
        this.registerAsset(assetId, base64);
      }
    }

    const scene = project.scenes.find((candidate) => candidate.id === sceneId);
    if (!scene) {
      throw new Error(`Scene "${sceneId}" does not exist`);
    }

    this.#runtime = ThreeSceneRuntime.instantiate(project, sceneId);
    this.#runtime.scene.background = new THREE.Color("#0b0d12");
    this.#projectRevision = projectRevision;

    const modelReport = await this.#runtime.loadModels(this.#assetResolver);
    for (const [entityId, meta] of modelReport) {
      if (meta.loaded) {
        this.#log("info", "model.loaded", {
          entityId,
          assetId: meta.assetId,
          meshCount: meta.meshCount,
          nodeCount: meta.nodeCount,
          bounds: meta.bounds,
        });
      } else {
        this.#log("error", "model.loadFailed", {
          entityId,
          assetId: meta.assetId,
          error: meta.error ?? "Unknown model loading failure",
        });
      }
    }

    try {
      this.#physics = await createPhysicsWorldFromScene(scene);
      this.#syncTransformsFromPhysics();
    } catch (error) {
      console.error("Physics initialization error:", error);
    }

    this.#camera =
      [...this.#runtime.objects().values()].find(
        (object): object is THREE.PerspectiveCamera =>
          object instanceof THREE.PerspectiveCamera,
      ) ?? this.#createFallbackCamera();

    this.resize();
    this.renderOnce();
    this.#log("info", "runtime.started", { sceneId, projectRevision });

    return this.query();
  }

  stop(): void {
    if (this.#physics) {
      this.#physics.dispose();
      this.#physics = undefined;
    }

    if (this.#navMesh) {
      this.#navMesh.dispose();
      this.#navMesh = undefined;
    }
    this.#navigationState = { hasNavMesh: false };
    this.#assetRegistry.clear();

    if (!this.#runtime) {
      return;
    }

    const sceneId = this.#runtime.sceneId;
    this.#runtime.dispose();
    this.#runtime = undefined;
    this.#projectRevision = undefined;
    this.#camera = this.#createFallbackCamera();
    this.#log("info", "runtime.stopped", { sceneId });
  }

  async bakeNavigation(input: {
    positions?: number[];
    indices?: number[];
    config?: Record<string, unknown>;
  }): Promise<void> {
    if (this.#navMesh) {
      this.#navMesh.dispose();
      this.#navMesh = undefined;
    }

    const positions = input.positions;
    const indices = input.indices;

    if (!positions || !indices) {
      throw new Error(
        "Navigation bake requires positions and indices geometry buffers",
      );
    }

    this.#navMesh = await RecastNavMesh.bake({
      positions,
      indices,
      ...(input.config as any),
    });

    const serialized = uint8ArrayToBase64(this.#navMesh.toBytes());
    this.#navigationState = {
      hasNavMesh: true,
      serialized,
    };
    this.#log("info", "navigation.baked", {
      vertexCount: positions.length / 3,
      triangleCount: indices.length / 3,
    });
  }

  async loadNavigation(dataBase64: string): Promise<void> {
    if (this.#navMesh) {
      this.#navMesh.dispose();
      this.#navMesh = undefined;
    }

    const bytes = base64ToUint8Array(dataBase64);
    this.#navMesh = await RecastNavMesh.fromBytes(bytes);
    this.#navigationState = {
      hasNavMesh: true,
      serialized: dataBase64,
    };
    this.#log("info", "navigation.loaded", { byteLength: bytes.byteLength });
  }

  closestPoint(
    position: [number, number, number],
    halfExtents?: [number, number, number],
  ): [number, number, number] {
    if (!this.#navMesh) {
      throw new Error(
        "Cannot query closest point: NavMesh is not baked or loaded",
      );
    }

    const queryExtents = halfExtents
      ? { x: halfExtents[0], y: halfExtents[1], z: halfExtents[2] }
      : undefined;

    const result = this.#navMesh.closestPoint(
      { x: position[0], y: position[1], z: position[2] },
      queryExtents ? { halfExtents: queryExtents } : undefined,
    );

    const pt: [number, number, number] = [result.x, result.y, result.z];
    this.#navigationState.lastClosestPoint = { point: pt };
    this.#log("debug", "navigation.closestPoint", {
      query: position,
      result: pt,
    });
    return pt;
  }

  computePath(
    start: [number, number, number],
    end: [number, number, number],
    halfExtents?: [number, number, number],
  ): {
    success: boolean;
    status: "complete" | "failed" | "partial";
    pointCount: number;
    points: Array<[number, number, number]>;
  } {
    if (!this.#navMesh) {
      throw new Error("Cannot compute path: NavMesh is not baked or loaded");
    }

    const queryExtents = halfExtents
      ? { x: halfExtents[0], y: halfExtents[1], z: halfExtents[2] }
      : undefined;

    const result = this.#navMesh.computePath(
      { x: start[0], y: start[1], z: start[2] },
      { x: end[0], y: end[1], z: end[2] },
      queryExtents ? { halfExtents: queryExtents } : undefined,
    );

    const points: Array<[number, number, number]> = result.points.map((p) => [
      p.x,
      p.y,
      p.z,
    ]);

    const pathState = {
      success: result.success,
      status: result.status,
      pointCount: points.length,
      points,
    };

    this.#navigationState.lastPath = pathState;
    this.#log("debug", "navigation.computePath", {
      start,
      end,
      success: result.success,
      status: result.status,
      pointCount: points.length,
    });

    return pathState;
  }

  playAnimation(
    entityId: string,
    clipName: string,
    options: { loop?: boolean } = {},
  ): { success: boolean; error?: string } {
    if (!this.#runtime) {
      const error = "Runtime is not running";
      this.#log("error", "animation.playFailed", { entityId, clip: clipName, error });
      return { success: false, error };
    }

    const object = this.#runtime.getObject(entityId);
    if (!object) {
      const error = `Entity "${entityId}" does not exist in runtime`;
      this.#log("error", "animation.playFailed", { entityId, clip: clipName, error });
      return { success: false, error };
    }

    const modelMeta = this.#runtime.getModelMetadata(entityId);
    if (!modelMeta || !modelMeta.loaded) {
      const error = `Entity "${entityId}" has no loaded model`;
      this.#log("error", "animation.playFailed", { entityId, clip: clipName, error });
      return { success: false, error };
    }

    const success = this.#runtime.playAnimation(entityId, clipName, options);
    if (!success) {
      const error = `Clip "${clipName}" not found on entity "${entityId}"`;
      this.#log("error", "animation.playFailed", { entityId, clip: clipName, error });
      return { success: false, error };
    }

    this.#log("info", "animation.played", {
      entityId,
      clip: clipName,
      loop: options.loop !== false,
    });
    return { success: true };
  }

  stopAnimation(entityId: string): void {
    if (!this.#runtime) return;
    this.#runtime.stopAnimation(entityId);
    this.#log("info", "animation.stopped", { entityId });
  }

  query(query: PlayerRuntimeQuery = {}): PlayerRuntimeQueryResult {
    if (!this.#runtime) {
      return { running: false, entities: [] };
    }

    const requested = query.entityIds ? new Set(query.entityIds) : undefined;
    const entities: PlayerRuntimeEntityState[] = [];

    for (const [entityId, object] of this.#runtime.objects()) {
      if (requested && !requested.has(entityId)) {
        continue;
      }

      const parentEntityId =
        typeof object.parent?.userData?.kinetra?.entityId === "string"
          ? object.parent.userData.kinetra.entityId
          : undefined;

      const modelMeta = this.#runtime.getModelMetadata(entityId);

      entities.push({
        entityId,
        name: object.name,
        objectType: object.type,
        ...(parentEntityId ? { parentEntityId } : {}),
        position: [object.position.x, object.position.y, object.position.z],
        rotation: [object.rotation.x, object.rotation.y, object.rotation.z],
        scale: [object.scale.x, object.scale.y, object.scale.z],
        ...(modelMeta
          ? {
              model: {
                assetId: modelMeta.assetId,
                loaded: modelMeta.loaded,
                meshCount: modelMeta.meshCount,
                nodeCount: modelMeta.nodeCount,
                ...(modelMeta.bounds ? { bounds: modelMeta.bounds } : {}),
                ...(modelMeta.animation ? { animation: modelMeta.animation } : {}),
                ...(modelMeta.nodes ? { nodes: modelMeta.nodes } : {}),
                ...(modelMeta.error ? { error: modelMeta.error } : {}),
              },
            }
          : {}),
      });
    }

    entities.sort((left, right) => left.entityId.localeCompare(right.entityId));

    return {
      running: true,
      sceneId: this.#runtime.sceneId,
      ...(this.#projectRevision !== undefined
        ? { projectRevision: this.#projectRevision }
        : {}),
      entities,
      navigation: structuredClone(this.#navigationState),
    };
  }

  injectInput(event: PlayerRuntimeInput): void {
    if (!this.#runtime) {
      throw new Error("Runtime is not running");
    }

    let displacementActual: number | undefined;

    if (this.#physics) {
      const characterIds = this.#physics.characterIds();
      const rawValue = event.value;
      const magnitude =
        typeof rawValue === "number"
          ? rawValue
          : Array.isArray(rawValue) && typeof rawValue[0] === "number"
            ? rawValue[0]
            : 1;

      let desired = { x: 0, y: 0, z: 0 };
      if (
        event.action === "player.moveRight" ||
        event.action === "move.right"
      ) {
        desired = { x: magnitude, y: 0, z: 0 };
      } else if (
        event.action === "player.moveLeft" ||
        event.action === "move.left"
      ) {
        desired = { x: -magnitude, y: 0, z: 0 };
      } else if (
        event.action === "player.moveForward" ||
        event.action === "move.forward"
      ) {
        desired = { x: 0, y: 0, z: -magnitude };
      } else if (
        event.action === "player.moveBackward" ||
        event.action === "move.backward"
      ) {
        desired = { x: 0, y: 0, z: magnitude };
      }

      if (desired.x !== 0 || desired.y !== 0 || desired.z !== 0) {
        for (const charId of characterIds) {
          const moveResult = this.#physics.moveCharacter(charId, desired);
          displacementActual =
            moveResult.actual.x !== 0
              ? moveResult.actual.x
              : moveResult.actual.z !== 0
                ? moveResult.actual.z
                : moveResult.actual.y;
        }
        this.#syncTransformsFromPhysics();
      }
    }

    this.#log("debug", "runtime.input", {
      action: event.action,
      phase: event.phase,
      ...(event.value !== undefined ? { value: event.value } : {}),
      ...(event.durationMs !== undefined
        ? { durationMs: event.durationMs }
        : {}),
      ...(displacementActual !== undefined ? { displacementActual } : {}),
    });
  }

  step(steps = 1, fixedDeltaSeconds = 1 / 60): void {
    if (this.#physics) {
      for (let i = 0; i < steps; i++) {
        this.#physics.step(fixedDeltaSeconds);
      }
      this.#syncTransformsFromPhysics();
    }
    if (this.#runtime) {
      this.#runtime.updateAnimation(steps * fixedDeltaSeconds);
    }
    this.renderOnce();
  }

  readLogs(sinceSequence = 0): PlayerRuntimeLog[] {
    return this.#logs
      .filter((entry) => entry.sequence > sinceSequence)
      .map((entry) => structuredClone(entry));
  }

  resize(): void {
    const width = Math.max(1, window.innerWidth);
    const height = Math.max(1, window.innerHeight);

    this.renderer.setSize(width, height, false);

    if (this.#camera instanceof THREE.PerspectiveCamera) {
      this.#camera.aspect = width / height;
      this.#camera.updateProjectionMatrix();
    }
  }

  renderOnce(): void {
    if (!this.#runtime) {
      this.renderer.clear();
      return;
    }

    this.renderer.render(this.#runtime.scene, this.#camera);
  }

  frame(deltaSeconds = 1 / 60): void {
    if (this.#physics) {
      this.#physics.advance(deltaSeconds);
      this.#syncTransformsFromPhysics();
    }
    if (this.#runtime) {
      this.#runtime.updateAnimation(deltaSeconds);
    }
    this.renderOnce();
  }

  #syncTransformsFromPhysics(): void {
    if (!this.#runtime || !this.#physics) {
      return;
    }

    for (const id of this.#physics.bodyIds()) {
      const object = this.#runtime.getObject(id);
      if (!object) {
        continue;
      }

      try {
        const state = this.#physics.state(id);
        object.position.set(
          state.position.x,
          state.position.y,
          state.position.z,
        );
        object.quaternion.set(
          state.rotation.x,
          state.rotation.y,
          state.rotation.z,
          state.rotation.w,
        );
      } catch (error) {
        console.error(`Physics state sync error for "${id}":`, error);
      }
    }
  }

  #createFallbackCamera(): THREE.PerspectiveCamera {
    const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 1000);
    camera.position.set(4, 3, 6);
    camera.lookAt(0, 0.5, 0);
    return camera;
  }

  #log(
    level: PlayerRuntimeLogLevel,
    message: string,
    data?: Record<string, unknown>,
  ): void {
    this.#logs.push({
      sequence: this.#nextLogSequence++,
      level,
      message,
      ...(data ? { data: structuredClone(data) } : {}),
    });
  }
}
