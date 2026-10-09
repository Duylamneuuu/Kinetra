import {
  assertValidProject,
  type ProjectDocument,
} from "@kinetra/project-model";
// Rapier (~2.8 MB of inlined WASM source) and Recast are loaded on demand
// with dynamic import() so the first-paint chunk stays small (see
// .kinetra/bundle-budget.json). Only types are imported statically.
import type { RapierPhysicsWorld } from "@kinetra/physics-rapier";
import type { RecastNavMesh } from "@kinetra/navigation-recast";
import {
  ThreeSceneRuntime,
  type AssetResolver,
  type BlendSpaceRuntimeResult,
  type ModelMorphTargetsState,
  type MorphTargetDiagnostic,
} from "@kinetra/renderer-three";
import type { BlendSpaceDefinition } from "@kinetra/animation/blend-space.js";
import type {
  AnimationGraphDefinition,
  AnimationGraphDiagnostic,
  AnimationTransitionResult,
} from "@kinetra/animation/graph.js";
import type {
  RootMotionMode,
  RootMotionDiagnostics,
} from "@kinetra/animation/root-motion.js";
import {
  ScriptHost,
  ScriptRegistry,
  PlayerControllerScript,
  type GameModule,
  type GameModuleRegistry,
  type GameScript,
  type GameScriptContext,
  type ScriptLifecycleState,
  type PreparedScriptRestore,
} from "@kinetra/core";
import { assertFiniteVec3, translatedPosition } from "./finite-vec3.js";
import { compareCodeUnits, createKeyedRecord } from "./keyed-record.js";
import { registerSaveLoadTestFixtures } from "./test-fixtures.js";
import {
  InputRouter,
  DEFAULT_PLAYER_INPUT_MAP,
  type GamepadSnapshotProvider,
  BrowserGamepadSnapshotProvider,
  type PhysicalInputSnapshot,
} from "@kinetra/input";
import { createBuiltinGameModules } from "./game-modules.js";
import {
  JsonDocumentStore,
  MemoryStorage,
  IpcKeyValueStorage,
  type KeyValueStorage,
  SaveMigrator,
  createGameplaySaveMigrator,
  CURRENT_SAVE_SCHEMA_VERSION,
  type SaveEnvelope,
  type EntitySaveState,
  type GameplaySaveData,
} from "@kinetra/save-state";
import type { AudioRuntimeState } from "@kinetra/audio";
import {
  PlayerAudioController,
  type PlayAudioOptions,
  type PlayAudioResult,
  type StopAudioOptions,
  type StopAudioResult,
} from "./audio-controller.js";
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

export interface PlayerRuntimeModelAnimationActionState {
  clip: string;
  weight: number;
  role: "incoming" | "outgoing" | "active" | "blend";
}

export interface PlayerRuntimeModelBlendSpaceState {
  id: string;
  kind: "1d" | "2d";
  parameters: string[];
  input: Record<string, number>;
  weights: Array<{ clip: string; weight: number }>;
  phase: number;
  cycleDuration: number;
  speed: number;
  groupWeight: number;
  dominantClip: string;
}

export interface PlayerRuntimeModelAnimationGraphState {
  state: string;
  previousState?: string | undefined;
  transitionId?: string | undefined;
  transitioning: boolean;
  blendSeconds?: number | undefined;
  blendElapsed?: number | undefined;
  blendProgress?: number | undefined;
}

export interface PlayerRuntimeModelAnimationState {
  clips: Array<{ name: string; duration: number }>;
  activeClip?: string | undefined;
  playing: boolean;
  time: number;
  duration?: number | undefined;
  retargetSource?: string | undefined;
  retargetCacheKey?: string | undefined;
  graph?: PlayerRuntimeModelAnimationGraphState | undefined;
  actions?: PlayerRuntimeModelAnimationActionState[] | undefined;
  rootMotion?: PlayerRuntimeRootMotionState | undefined;
  blendSpace?: PlayerRuntimeModelBlendSpaceState | undefined;
}

export interface PlayerRuntimeRootMotionState {
  enabled: boolean;
  mode: RootMotionMode;
  sourceClip?: string | undefined;
  requestedDelta: [number, number, number];
  appliedDelta: [number, number, number];
  blockedDelta: [number, number, number];
  requestedYaw: number;
  appliedYaw: number;
  collisionClipped: boolean;
  accumulatedDistance: number;
  error?: string | undefined;
}

export interface PlayerRuntimeModelNodeState {
  name: string;
  position: [number, number, number];
  rotation?: [number, number, number, number];
  scale?: [number, number, number];
}

export interface PlayerRuntimeModelInstanceMetadata {
  assetId: string;
  instanceId: string;
  sharedTemplateId: string;
  skinnedMeshCount: number;
  skeletonCount: number;
  fingerprint?: string | undefined;
  templateRevision?: number | undefined;
}

export interface PlayerRuntimeModelResourceSharingMetadata {
  templateRefCount: number;
}

export interface PlayerRuntimeModelState {
  assetId: string;
  loaded: boolean;
  meshCount: number;
  nodeCount: number;
  skinnedMeshCount?: number | undefined;
  hasSkin?: boolean | undefined;
  bounds?: {
    min: [number, number, number];
    max: [number, number, number];
    size: [number, number, number];
  } | undefined;
  animation?: PlayerRuntimeModelAnimationState | undefined;
  nodes?: PlayerRuntimeModelNodeState[] | undefined;
  morphTargets?: ModelMorphTargetsState | undefined;
  instance?: PlayerRuntimeModelInstanceMetadata | undefined;
  resourceSharing?: PlayerRuntimeModelResourceSharingMetadata | undefined;
  assetFingerprint?: string | undefined;
  templateRevision?: number | undefined;
  error?: string | undefined;
}


export interface PlayerRuntimeGameplayState {
  scriptId: string;
  lifecycleState: ScriptLifecycleState;
  updateCount: number;
  state?: Record<string, unknown>;
  rootMotion?: PlayerRuntimeRootMotionState | undefined;
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
  gameplay?: PlayerRuntimeGameplayState;
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

export type GameShellMode =
  | "mainMenu"
  | "playing"
  | "paused"
  | "settings"
  | "won"
  | "lost";

export interface PlayerRuntimeAssetQueryInfo {
  assetId: string;
  sourceHash?: string | undefined;
  fingerprint?: string | undefined;
  importStatus: "imported" | "reimporting" | "failed" | "unimported";
  revision?: number | undefined;
  dependentIds?: string[] | undefined;
  error?: string | undefined;
}

export interface PlayerRuntimeAssetsQueryState {
  byId: Record<string, PlayerRuntimeAssetQueryInfo>;
}

export interface PlayerRuntimePerformanceTiming {
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
}

export interface PlayerRuntimePerformanceRendererMetrics {
  drawCalls: number;
  triangles: number;
  points: number;
  lines: number;
  geometries: number;
  textures: number;
}

export interface PlayerRuntimePerformanceSceneMetrics {
  objectCount: number;
  visibleObjectCount: number;
  modelInstanceCount: number;
  skinnedMeshCount: number;
  activeAnimationMixerCount: number;
}

export interface PlayerRuntimePerformancePhysicsMetrics {
  bodyCount: number;
  colliderCount: number;
}

export interface PlayerRuntimePerformanceEvidence {
  sampleCount: number;
  warmupSamples: number;
  executionMode: "stepped" | "continuous";
  frame: PlayerRuntimePerformanceTiming;
  simulation: PlayerRuntimePerformanceTiming;
  render: PlayerRuntimePerformanceTiming;
  renderer: PlayerRuntimePerformanceRendererMetrics;
  scene: PlayerRuntimePerformanceSceneMetrics;
  physics?: PlayerRuntimePerformancePhysicsMetrics;
}

export interface PlayerRuntimeRendererState {
  captureMode: "performance" | "visual";
  preserveDrawingBuffer: boolean;
}

export interface PlayerRuntimeControllerOptions {
  captureMode?: "performance" | "visual";
}

export interface PlayerRuntimeQueryResult {
  running: boolean;
  /** Id of the game module the running scene was started with (e.g. "arena", "orb-run"). */
  gameId?: string;
  sceneId?: string;
  projectRevision?: number;
  entities: PlayerRuntimeEntityState[];
  navigation?: PlayerRuntimeNavigationState;
  audio?: AudioRuntimeState;
  gameplay?: Record<string, unknown>;
  game?: Record<string, unknown>;
  shell?: { mode: GameShellMode; isPaused: boolean };
  metrics?: Record<string, number>;
  renderer?: PlayerRuntimeRendererState;
  assets?: PlayerRuntimeAssetsQueryState | undefined;
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

function isEqualJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) {
    return false;
  }
  const keysA = Object.keys(a as object).sort();
  const keysB = Object.keys(b as object).sort();
  if (keysA.length !== keysB.length) return false;
  for (let i = 0; i < keysA.length; i++) {
    const key = keysA[i]!;
    if (key !== keysB[i]) return false;
    if (!isEqualJson((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) {
      return false;
    }
  }
  return true;
}

export class PlayerRuntimeController {
  readonly renderer: THREE.WebGLRenderer;

  #runtime: ThreeSceneRuntime | undefined;
  #physics: RapierPhysicsWorld | undefined;
  #navMesh: RecastNavMesh | undefined;
  #navigationState: PlayerRuntimeNavigationState = { hasNavMesh: false };
  #assetResolver: AssetResolver;
  #assetRegistry = new Map<string, Uint8Array>();
  #assetFingerprints = new Map<string, string>();
  #assetSourceHashes = new Map<string, string>();
  #assetStatuses = new Map<string, "imported" | "reimporting" | "failed" | "unimported">();
  #assetRevisions = new Map<string, number>();
  #scripts: ScriptHost = new ScriptHost();
  // Engine-level scripts, test fixtures and scripts added with registerScript().
  #scriptRegistry: ScriptRegistry = new ScriptRegistry();
  // Game-specific scripts for the running game; rebuilt on every start so one
  // game's scripts never leak into the next (see game-modules.ts).
  #gameModules: GameModuleRegistry = createBuiltinGameModules();
  #activeGame: GameModule | undefined;
  #gameScripts: ScriptRegistry | undefined;
  #inputRouter: InputRouter = new InputRouter(DEFAULT_PLAYER_INPUT_MAP);
  #unresolvedScripts = new Map<string, { scriptId: string; error: string }>();
  #stepped = false;
  #camera: THREE.Camera;
  #projectRevision: number | undefined;
  #logs: PlayerRuntimeLog[] = [];
  #nextLogSequence = 1;
  #storage: KeyValueStorage;
  #saveStore: JsonDocumentStore<SaveEnvelope<GameplaySaveData>>;
  #saveMigrator: SaveMigrator;
  #audio: PlayerAudioController = new PlayerAudioController();
  #lifecycleQueue: Promise<unknown> = Promise.resolve();
  #paused = false;
  #shellMode: GameShellMode = "mainMenu";
  #gamepadProvider: GamepadSnapshotProvider = new BrowserGamepadSnapshotProvider();
  #activeKeys = new Set<string>();
  #lastPausePressed = false;
  readonly captureMode: "performance" | "visual";
  readonly preserveDrawingBuffer: boolean;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    options?: PlayerRuntimeControllerOptions,
  ) {
    this.captureMode = options?.captureMode === "visual" ? "visual" : "performance";
    this.preserveDrawingBuffer = this.captureMode === "visual";
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: "high-performance",
      preserveDrawingBuffer: this.preserveDrawingBuffer,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    this.#saveMigrator = createGameplaySaveMigrator();
    const platform =
      typeof window !== "undefined" ? window.kinetraPlatform : undefined;
    const storage =
      platform && typeof platform.storageGet === "function"
        ? new IpcKeyValueStorage(platform)
        : new MemoryStorage();

    this.#storage = storage;
    this.#saveStore = new JsonDocumentStore<SaveEnvelope<GameplaySaveData>>(
      storage,
      "saves",
    );

    this.#scriptRegistry.register("PlayerController", () => new PlayerControllerScript());

    this.#assetResolver = {
      resolve: (assetId: string) => {
        return this.#assetRegistry.get(assetId);
      },
      getFingerprint: (assetId: string) => {
        return this.#assetFingerprints.get(assetId);
      },
    };

    this.#camera = this.#createFallbackCamera();
    if (typeof window !== "undefined") {
      window.addEventListener("resize", () => this.resize());
      window.addEventListener("keydown", (e) => {
        this.#activeKeys.add(e.code);
      });
      window.addEventListener("keyup", (e) => {
        this.#activeKeys.delete(e.code);
      });
    }
    this.resize();
  }

  pause(): void {
    this.#paused = true;
    if (this.#shellMode === "playing") {
      this.#shellMode = "paused";
    }
    this.#log("info", "game.paused");
  }

  resume(): void {
    this.#paused = false;
    if (this.#shellMode === "paused") {
      this.#shellMode = "playing";
    }
    this.#log("info", "game.resumed");
  }

  togglePause(): boolean {
    if (this.#paused) {
      this.resume();
    } else {
      this.pause();
    }
    return this.#paused;
  }

  isPaused(): boolean {
    return this.#paused;
  }

  getShellMode(): GameShellMode {
    return this.#shellMode;
  }

  setShellMode(mode: GameShellMode): void {
    this.#shellMode = mode;
  }

  getInputRouter(): InputRouter {
    return this.#inputRouter;
  }

  getAudioController(): PlayerAudioController {
    return this.#audio;
  }

  getStorage(): KeyValueStorage {
    return this.#storage;
  }

  getSaveStore(): JsonDocumentStore<SaveEnvelope<GameplaySaveData>> {
    return this.#saveStore;
  }

  async hasSave(slotId: string): Promise<boolean> {
    try {
      const envelope = await this.#saveStore.load(slotId);
      return Boolean(envelope);
    } catch {
      return false;
    }
  }

  setGamepadProvider(provider: GamepadSnapshotProvider): void {
    this.#gamepadProvider = provider;
  }

  getActiveKeys(): Set<string> {
    return this.#activeKeys;
  }

  registerScript(
    scriptId: string,
    factory: (context: GameScriptContext) => GameScript,
  ): void {
    this.#scriptRegistry.register(scriptId, factory);
  }

  enableTestScriptFixtures(preset: "save-load-atomicity"): void {
    if (preset === "save-load-atomicity") {
      registerSaveLoadTestFixtures(this.#scriptRegistry);
      this.#log("info", "testHarness.fixturesEnabled", { preset });
    }
  }

  registerAsset(
    assetId: string,
    data: Uint8Array | string,
    options?: { fingerprint?: string | undefined; sourceHash?: string | undefined },
  ): void {
    const bytes = typeof data === "string" ? base64ToUint8Array(data) : data;
    this.#assetRegistry.set(assetId, bytes);
    this.#assetStatuses.set(assetId, "imported");
    this.#assetRevisions.set(assetId, 1);
    if (options?.fingerprint) {
      this.#assetFingerprints.set(assetId, options.fingerprint);
    }
    if (options?.sourceHash) {
      this.#assetSourceHashes.set(assetId, options.sourceHash);
    }
    this.#log("debug", "asset.registered", {
      assetId,
      byteLength: bytes.byteLength,
    });
  }

  updateAsset(
    assetId: string,
    data: Uint8Array | string,
    options?: { fingerprint?: string | undefined; sourceHash?: string | undefined },
  ): void {
    const bytes = typeof data === "string" ? base64ToUint8Array(data) : data;
    this.#assetRegistry.set(assetId, bytes);
    const revision = (this.#assetRevisions.get(assetId) ?? 0) + 1;
    this.#assetRevisions.set(assetId, revision);
    if (options?.fingerprint) {
      this.#assetFingerprints.set(assetId, options.fingerprint);
    }
    if (options?.sourceHash) {
      this.#assetSourceHashes.set(assetId, options.sourceHash);
    }
    this.#assetStatuses.set(assetId, "imported");
    this.#log("info", "asset.updated", {
      assetId,
      byteLength: bytes.byteLength,
      revision,
      fingerprint: options?.fingerprint,
    });
  }

  async start(
    project: ProjectDocument,
    sceneId: string,
    projectRevision: number,
    options?: {
      assets?: Record<string, string>;
      assetMetadata?: Record<string, { fingerprint?: string; sourceHash?: string }>;
      stepped?: boolean;
      testScriptPreset?: string;
      /** Game module id (see game-modules.ts). Omitted selects the default game (Arena). */
      game?: string;
    },
  ): Promise<PlayerRuntimeQueryResult> {
    const queue = this.#lifecycleQueue;
    let releaseLock!: () => void;
    this.#lifecycleQueue = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    try {
      await queue;
      return await this.#doStart(project, sceneId, projectRevision, options);
    } finally {
      releaseLock();
    }
  }

  async stop(): Promise<void> {
    const queue = this.#lifecycleQueue;
    let releaseLock!: () => void;
    this.#lifecycleQueue = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    try {
      await queue;
      return await this.#doStop();
    } finally {
      releaseLock();
    }
  }

  async #doStart(
    project: ProjectDocument,
    sceneId: string,
    projectRevision: number,
    options?: {
      assets?: Record<string, string>;
      assetMetadata?: Record<string, { fingerprint?: string; sourceHash?: string }>;
      stepped?: boolean;
      testScriptPreset?: string;
      /** Game module id (see game-modules.ts). Omitted selects the default game (Arena). */
      game?: string;
    },
  ): Promise<PlayerRuntimeQueryResult> {
    if (options?.testScriptPreset === "save-load-atomicity") {
      this.enableTestScriptFixtures("save-load-atomicity");
    }
    assertValidProject(project);

    // Validate everything that can fail before tearing down a running game, so a
    // bad request (unknown game, wrong scene) leaves the current run untouched.
    const scene = project.scenes.find((candidate) => candidate.id === sceneId);
    if (!scene) {
      throw new Error(`Scene "${sceneId}" does not exist`);
    }
    const { module: game, registry: gameScripts } = await this.#gameModules.createScriptRegistry(
      options?.game,
      { project, sceneId },
    );

    await this.#doStop();
    this.#activeGame = game;
    this.#gameScripts = gameScripts;
    this.#stepped = options?.stepped ?? false;

    if (options?.assets) {
      for (const [assetId, base64] of Object.entries(options.assets)) {
        const meta = options.assetMetadata?.[assetId];
        this.registerAsset(assetId, base64, meta);
      }
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
      const { createPhysicsWorldFromScene } = await import(
        "@kinetra/physics-rapier"
      );
      this.#physics = await createPhysicsWorldFromScene(scene);
      this.#syncTransformsFromPhysics();
    } catch (error) {
      console.error("Physics initialization error:", error);
    }

    // Initialize NavMesh if present on any entity
    for (const entity of scene.entities) {
      const navComp =
        typeof entity.components.NavMesh === "object" && entity.components.NavMesh !== null
          ? (entity.components.NavMesh as Record<string, unknown>)
          : undefined;

      if (navComp) {
        try {
          if (typeof navComp.dataBase64 === "string") {
            await this.loadNavigation(navComp.dataBase64);
            break;
          } else if (Array.isArray(navComp.positions) && Array.isArray(navComp.indices)) {
            await this.bakeNavigation({
              positions: navComp.positions as number[],
              indices: navComp.indices as number[],
              ...(typeof navComp.config === "object" && navComp.config !== null
                ? { config: navComp.config as Record<string, unknown> }
                : {}),
            });
            break;
          }
        } catch (error) {
          this.#log("error", "navigation.initFailed", {
            entityId: entity.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    // Initialize scripts for entities with Script component
    for (const entity of scene.entities) {
      const scriptComp =
        typeof entity.components.Script === "object" && entity.components.Script !== null
          ? (entity.components.Script as Record<string, unknown>)
          : undefined;

      if (scriptComp && typeof scriptComp.scriptId === "string") {
        const scriptId = scriptComp.scriptId;
        const factory =
          this.#gameScripts?.resolve(scriptId) ?? this.#scriptRegistry.resolve(scriptId);
        if (!factory) {
          const error = `Script "${scriptId}" could not be resolved`;
          this.#unresolvedScripts.set(entity.id, { scriptId, error });
          this.#log("error", "script.resolveFailed", {
            entityId: entity.id,
            scriptId,
            error,
          });
        } else {
          const entityId = entity.id;
          const self = this;
          const script = factory({
            entityId,
            sceneId,
          });
          // Execution order comes from the authored Script component only; a game
          // that needs an order must author it (no script-name special cases).
          const order =
            typeof scriptComp.order === "number" && Number.isFinite(scriptComp.order)
              ? scriptComp.order
              : 0;
          this.#scripts.register({
            id: entityId,
            scriptId,
            order,
            context: {
              entityId,
              sceneId,
              input: {
                getAction: (actionId: string) => this.#inputRouter.getActionValue(actionId),
                isPressed: (actionId: string) => this.#inputRouter.isActionPressed(actionId),
              },
              transform: {
                getPosition: () => {
                  const obj = this.#runtime?.getObject(entityId);
                  return obj ? [obj.position.x, obj.position.y, obj.position.z] : [0, 0, 0];
                },
                setPosition: (rawPos: [number, number, number]) => {
                  // Validate before touching the Three.js object so a rejected call changes nothing.
                  const pos = assertFiniteVec3(rawPos, "transform.setPosition position");
                  const obj = this.#runtime?.getObject(entityId);
                  if (obj) {
                    obj.position.set(pos[0], pos[1], pos[2]);
                  }
                  if (this.#physics?.hasBody(entityId)) {
                    this.#physics.setBodyTranslation(
                      entityId,
                      { x: pos[0], y: pos[1], z: pos[2] },
                      true,
                    );
                  }
                },
                translate: (rawDelta: [number, number, number]) => {
                  const obj = this.#runtime?.getObject(entityId);
                  if (obj) {
                    const next = translatedPosition(
                      [obj.position.x, obj.position.y, obj.position.z],
                      rawDelta,
                      "transform.translate delta",
                    );
                    obj.position.set(next[0], next[1], next[2]);
                    if (this.#physics?.hasBody(entityId)) {
                      this.#physics.setBodyTranslation(
                        entityId,
                        { x: next[0], y: next[1], z: next[2] },
                        true,
                      );
                    }
                  }
                },
              },
              scene: {
                getEntityTransform: (targetId: string) => {
                  const obj = this.#runtime?.getObject(targetId);
                  return obj ? [obj.position.x, obj.position.y, obj.position.z] : undefined;
                },
                findEntityByName: (name: string) => {
                  if (!this.#runtime) return undefined;
                  for (const [id, obj] of this.#runtime.objects()) {
                    if (obj.name === name) {
                      return { entityId: id, name };
                    }
                  }
                  return undefined;
                },
              },
              navigation: {
                computePath: (start, end, halfExtents) => {
                  return this.computePath(start, end, halfExtents);
                },
                closestPoint: (pos, halfExtents) => {
                  return this.closestPoint(pos, halfExtents);
                },
              },
              audio: {
                play: async (options) => {
                  return await this.playAudio(options);
                },
              },
              animation: {
                play: (clipName: string, options?: { loop?: boolean }): boolean => {
                  const res = this.playAnimation(entityId, clipName, options);
                  return res.success;
                },
                stop: (): void => {
                  this.stopAnimation(entityId);
                },
                setMorphWeights: (weights: Record<string, number>): boolean => {
                  return this.setMorphWeights(entityId, weights).success;
                },
                clearMorphWeights: (names?: string[]): boolean => {
                  return this.clearMorphWeights(entityId, names).success;
                },
                get activeClip(): string | undefined {
                  const meta = self.#runtime?.getModelMetadata(entityId);
                  return meta?.animation?.activeClip;
                },
                get playing(): boolean {
                  const meta = self.#runtime?.getModelMetadata(entityId);
                  return meta?.animation?.playing ?? false;
                },
                graph: {
                  init: (graphDef: any) => {
                    return this.initAnimationGraph(entityId, graphDef);
                  },
                  setParameter: (name: string, value: boolean | number): boolean => {
                    const res = this.setAnimationGraphParameter(entityId, name, value);
                    return res.success;
                  },
                  set: (name: string, value: boolean | number): boolean => {
                    const res = this.setAnimationGraphParameter(entityId, name, value);
                    return res.success;
                  },
                  trigger: (name: string): boolean => {
                    const res = this.triggerAnimationGraph(entityId, name);
                    return res.success;
                  },
                  evaluate: () => {
                    return this.evaluateAnimationGraph(entityId).transition;
                  },
                  get state(): string | undefined {
                    const meta = self.#runtime?.getModelMetadata(entityId);
                    return meta?.animation?.graph?.state;
                  },
                  get transitioning(): boolean {
                    const meta = self.#runtime?.getModelMetadata(entityId);
                    return meta?.animation?.graph?.transitioning ?? false;
                  },
                  get blendProgress(): number | undefined {
                    const meta = self.#runtime?.getModelMetadata(entityId);
                    return meta?.animation?.graph?.blendProgress;
                  },
                },
              },
              emit: (event, payload) => {
                this.#scripts.emit(event, payload);
              },
              log: (level, category, data) => {
                this.#log(level, category, data);
              },
            },
            script,
          });
        }
      }
    }

    try {
      await this.#scripts.startAll();
    } catch (error) {
      console.error("Script initialization error:", error);
    }

    this.#camera =
      [...this.#runtime.objects().values()].find(
        (object): object is THREE.PerspectiveCamera =>
          object instanceof THREE.PerspectiveCamera,
      ) ?? this.#createFallbackCamera();

    this.resize();
    this.renderOnce();
    this.#audio.init(this.#assetResolver);
    this.#shellMode = "playing";
    this.#paused = false;
    this.#log("info", "runtime.started", { sceneId, projectRevision });

    return this.query();
  }

  async #doStop(): Promise<void> {
    this.#audio.reset();
    await this.#scripts.destroyAll();
    this.#scripts = new ScriptHost();
    this.#unresolvedScripts.clear();
    this.#inputRouter.clearSemanticActions();
    this.#gameScripts = undefined;
    this.#activeGame = undefined;

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
    this.#assetFingerprints.clear();
    this.#assetSourceHashes.clear();
    this.#assetStatuses.clear();
    this.#assetRevisions.clear();

    if (!this.#runtime) {
      return;
    }

    const sceneId = this.#runtime.sceneId;
    this.#runtime.dispose();
    this.#runtime = undefined;
    this.#projectRevision = undefined;
    this.#camera = this.#createFallbackCamera();
    this.#shellMode = "mainMenu";
    this.#paused = false;
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

    const { RecastNavMesh } = await import("@kinetra/navigation-recast");
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
    const { RecastNavMesh } = await import("@kinetra/navigation-recast");
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

  registerAnimationClip(
    entityId: string,
    clipData: unknown,
  ): { success: boolean; error?: string } {
    if (!this.#runtime) {
      const error = "Runtime is not running";
      this.#log("error", "animation.registerClipFailed", { entityId, error });
      return { success: false, error };
    }

    const object = this.#runtime.getObject(entityId);
    if (!object) {
      const error = `Entity "${entityId}" does not exist in runtime`;
      this.#log("error", "animation.registerClipFailed", { entityId, error });
      return { success: false, error };
    }

    try {
      let clip: THREE.AnimationClip;
      if (clipData instanceof THREE.AnimationClip) {
        clip = clipData;
      } else if (typeof clipData === "object" && clipData !== null) {
        const rawClip =
          "clip" in (clipData as Record<string, unknown>)
            ? (clipData as Record<string, unknown>).clip
            : clipData;
        clip = THREE.AnimationClip.parse(rawClip as any);
      } else {
        const error = "Invalid animation clip data provided";
        this.#log("error", "animation.registerClipFailed", { entityId, error });
        return { success: false, error };
      }

      const success = this.#runtime.registerAnimationClip(entityId, clip);
      if (!success) {
        const error = `Failed to register clip "${clip.name}" on entity "${entityId}"`;
        this.#log("error", "animation.registerClipFailed", { entityId, clip: clip.name, error });
        return { success: false, error };
      }

      this.#log("info", "animation.clipRegistered", {
        entityId,
        clip: clip.name,
        duration: clip.duration,
        trackCount: clip.tracks.length,
      });
      return { success: true };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.#log("error", "animation.registerClipFailed", { entityId, error });
      return { success: false, error };
    }
  }

  setMorphWeights(
    entityId: string,
    weights: unknown,
  ): { success: boolean; error?: string; diagnostics?: MorphTargetDiagnostic[] } {
    if (!this.#runtime) {
      const error = "Runtime is not running";
      this.#log("error", "animation.morphFailed", { entityId, error });
      return { success: false, error };
    }
    const result = this.#runtime.setMorphWeights(entityId, weights);
    if (!result.success) {
      this.#log("error", "animation.morphFailed", {
        entityId,
        error: result.error,
        codes: (result.diagnostics ?? []).map((d) => d.code),
      });
      return {
        success: false,
        ...(result.error ? { error: result.error } : {}),
        ...(result.diagnostics ? { diagnostics: result.diagnostics } : {}),
      };
    }
    this.#log("info", "animation.morphWeightsSet", {
      entityId,
      weights: Object.fromEntries((result.applied ?? []).map((u) => [u.name, u.weight])),
    });
    return { success: true };
  }

  clearMorphWeights(
    entityId: string,
    names?: unknown,
  ): { success: boolean; error?: string; diagnostics?: MorphTargetDiagnostic[]; cleared?: string[] } {
    if (!this.#runtime) {
      const error = "Runtime is not running";
      this.#log("error", "animation.morphFailed", { entityId, error });
      return { success: false, error };
    }
    const result = this.#runtime.clearMorphWeights(entityId, names);
    if (!result.success) {
      this.#log("error", "animation.morphFailed", {
        entityId,
        error: result.error,
        codes: (result.diagnostics ?? []).map((d) => d.code),
      });
      return {
        success: false,
        ...(result.error ? { error: result.error } : {}),
        ...(result.diagnostics ? { diagnostics: result.diagnostics } : {}),
      };
    }
    this.#log("info", "animation.morphWeightsCleared", { entityId, cleared: result.cleared ?? [] });
    return { success: true, cleared: result.cleared ?? [] };
  }

  setIkChains(entityId: string, chains: unknown): { success: boolean; error?: string; registered?: string[]; diagnostics?: unknown[] } {
    if (!this.#runtime) return { success: false, error: "Runtime is not running" };
    if (!Array.isArray(chains)) {
      const error = "chains must be an array of IK chain definitions";
      this.#log("error", "animation.ikFailed", { entityId, error });
      return { success: false, error };
    }
    const controller = this.#runtime.setIkChains(entityId, chains);
    if (!controller) {
      const error = `Entity "${entityId}" has no loaded model`;
      this.#log("error", "animation.ikFailed", { entityId, error });
      return { success: false, error };
    }
    const diagnostics = [...controller.registrationDiagnostics];
    this.#log(diagnostics.length > 0 ? "warning" : "info", "animation.ikChainsSet", {
      entityId,
      chains: controller.chainIds,
      ...(diagnostics.length > 0 ? { diagnostics: diagnostics.map((d) => d.code) } : {}),
    });
    // Rejected chains are reported, not silently skipped, so callers can see why a chain is missing.
    return { success: true, registered: [...controller.chainIds], diagnostics };
  }

  setIkTarget(
    entityId: string,
    chainId: unknown,
    target: unknown,
    options: { pole?: never; weight?: number },
  ): { success: boolean; error?: string; diagnostics?: unknown[] } {
    if (!this.#runtime) return { success: false, error: "Runtime is not running" };
    const result = this.#runtime.setIkTarget(entityId, chainId as string, target, options);
    if (!result.success) {
      this.#log("error", "animation.ikFailed", { entityId, error: result.error });
      return { success: false, ...(result.error ? { error: result.error } : {}), diagnostics: result.diagnostics };
    }
    return { success: true };
  }

  clearIkTarget(entityId: string, chainId?: string): { success: boolean; error?: string } {
    if (!this.#runtime) return { success: false, error: "Runtime is not running" };
    this.#runtime.clearIkTarget(entityId, chainId);
    return { success: true };
  }

  playAnimation(
    entityId: string,
    clipName: string,
    options: {
      loop?: boolean;
      retargetSource?: string;
      retargetCacheKey?: string;
    } = {},
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
      ...(options.retargetSource !== undefined ? { retargetSource: options.retargetSource } : {}),
      ...(options.retargetCacheKey !== undefined ? { retargetCacheKey: options.retargetCacheKey } : {}),
    });
    return { success: true };
  }

  crossfadeAnimation(
    entityId: string,
    clipName: string,
    blendSeconds: number = 0.15,
    options: {
      loop?: boolean | undefined;
      speed?: number | undefined;
      fromState?: string | undefined;
      toState?: string | undefined;
      transitionId?: string | undefined;
      retargetSource?: string | undefined;
      retargetCacheKey?: string | undefined;
    } = {},
  ): { success: boolean; error?: string } {
    if (!this.#runtime) {
      const error = "Runtime is not running";
      this.#log("error", "animation.crossfadeFailed", { entityId, clip: clipName, error });
      return { success: false, error };
    }

    const object = this.#runtime.getObject(entityId);
    if (!object) {
      const error = `Entity "${entityId}" does not exist in runtime`;
      this.#log("error", "animation.crossfadeFailed", { entityId, clip: clipName, error });
      return { success: false, error };
    }

    const modelMeta = this.#runtime.getModelMetadata(entityId);
    if (!modelMeta || !modelMeta.loaded) {
      const error = `Entity "${entityId}" has no loaded model`;
      this.#log("error", "animation.crossfadeFailed", { entityId, clip: clipName, error });
      return { success: false, error };
    }

    const success = this.#runtime.crossfadeAnimation(entityId, clipName, blendSeconds, options);
    if (!success) {
      const error = `Clip "${clipName}" not found on entity "${entityId}"`;
      this.#log("error", "animation.crossfadeFailed", { entityId, clip: clipName, error });
      return { success: false, error };
    }

    this.#log("info", "animation.crossfaded", {
      entityId,
      clip: clipName,
      blendSeconds,
      ...(options.fromState ? { fromState: options.fromState } : {}),
      ...(options.toState ? { toState: options.toState } : {}),
      ...(options.transitionId ? { transitionId: options.transitionId } : {}),
    });
    return { success: true };
  }

  playBlendSpace(
    entityId: string,
    space: BlendSpaceDefinition,
    options: { input?: Record<string, number> | undefined; speed?: number | undefined } = {},
  ): BlendSpaceRuntimeResult {
    if (!this.#runtime) {
      const error = "Runtime is not running";
      this.#log("error", "animation.blendSpace.playFailed", { entityId, code: "runtime.notRunning", error });
      return { success: false, code: "runtime.notRunning", error };
    }
    if (!this.#runtime.getObject(entityId)) {
      const error = `Entity "${entityId}" does not exist in runtime`;
      this.#log("error", "animation.blendSpace.playFailed", { entityId, code: "entity.notFound", error });
      return { success: false, code: "entity.notFound", error };
    }
    const result = this.#runtime.playBlendSpace(entityId, space, options);
    if (!result.success) {
      this.#log("error", "animation.blendSpace.playFailed", {
        entityId,
        code: result.code,
        error: result.error,
        ...(result.diagnostics ? { diagnostics: result.diagnostics } : {}),
      });
      return result;
    }
    this.#log("info", "animation.blendSpace.played", {
      entityId,
      blendSpaceId: result.state?.id,
      kind: result.state?.kind,
      weights: result.state?.weights,
    });
    return result;
  }

  setBlendSpaceInput(entityId: string, input: Record<string, number>): BlendSpaceRuntimeResult {
    if (!this.#runtime) {
      const error = "Runtime is not running";
      this.#log("error", "animation.blendSpace.inputFailed", { entityId, code: "runtime.notRunning", error });
      return { success: false, code: "runtime.notRunning", error };
    }
    const result = this.#runtime.setBlendSpaceInput(entityId, input);
    if (!result.success) {
      this.#log("error", "animation.blendSpace.inputFailed", { entityId, code: result.code, error: result.error });
    }
    return result;
  }

  initAnimationGraph(
    entityId: string,
    graph: AnimationGraphDefinition,
  ): { success: boolean; error?: string; diagnostics?: AnimationGraphDiagnostic[] } {
    if (!this.#runtime) {
      const error = "Runtime is not running";
      this.#log("error", "animation.graph.initFailed", { entityId, error });
      return { success: false, error };
    }

    const object = this.#runtime.getObject(entityId);
    if (!object) {
      const error = `Entity "${entityId}" does not exist in runtime`;
      this.#log("error", "animation.graph.initFailed", { entityId, error });
      return { success: false, error };
    }

    const modelMeta = this.#runtime.getModelMetadata(entityId);
    if (!modelMeta || !modelMeta.loaded) {
      const error = `Entity "${entityId}" has no loaded model`;
      this.#log("error", "animation.graph.initFailed", { entityId, error });
      return { success: false, error };
    }

    const result = this.#runtime.initAnimationGraph(entityId, graph);
    if (!result.success) {
      this.#log("error", "animation.graph.initFailed", {
        entityId,
        error: result.error,
        diagnostics: result.diagnostics,
      });
      return result;
    }

    this.#log("info", "animation.graph.initialized", {
      entityId,
      entryState: graph.entryState,
    });
    return { success: true };
  }

  setAnimationGraphParameter(
    entityId: string,
    name: string,
    value: boolean | number,
  ): { success: boolean; error?: string; transition?: AnimationTransitionResult } {
    if (!this.#runtime) {
      const error = "Runtime is not running";
      this.#log("error", "animation.graph.parameterFailed", { entityId, parameter: name, error });
      return { success: false, error };
    }

    const result = this.#runtime.setAnimationGraphParameter(entityId, name, value);
    if (!result.success) {
      this.#log("error", "animation.graph.parameterFailed", {
        entityId,
        parameter: name,
        value,
        error: result.error,
      });
      return result;
    }

    this.#log("info", "animation.graph.parameterSet", {
      entityId,
      parameter: name,
      value,
      ...(result.transition ? { transition: result.transition } : {}),
    });
    return result;
  }

  triggerAnimationGraph(
    entityId: string,
    name: string,
  ): { success: boolean; error?: string; transition?: AnimationTransitionResult } {
    if (!this.#runtime) {
      const error = "Runtime is not running";
      this.#log("error", "animation.graph.triggerFailed", { entityId, trigger: name, error });
      return { success: false, error };
    }

    const result = this.#runtime.triggerAnimationGraph(entityId, name);
    if (!result.success) {
      this.#log("error", "animation.graph.triggerFailed", {
        entityId,
        trigger: name,
        error: result.error,
      });
      return result;
    }

    this.#log("info", "animation.graph.triggered", {
      entityId,
      trigger: name,
      ...(result.transition ? { transition: result.transition } : {}),
    });
    return result;
  }

  evaluateAnimationGraph(entityId: string): { transition?: AnimationTransitionResult } {
    if (!this.#runtime) return {};
    const result = this.#runtime.evaluateAnimationGraph(entityId);
    if (result.transition) {
      this.#log("info", "animation.graph.transitioned", {
        entityId,
        transition: result.transition,
      });
    }
    return result;
  }

  stopAnimation(entityId: string): void {
    if (!this.#runtime) return;
    this.#runtime.stopAnimation(entityId);
    this.#log("info", "animation.stopped", { entityId });
  }

  configureRootMotion(
    entityId: string,
    options: {
      enabled: boolean;
      mode?: RootMotionMode | undefined;
      rootBoneName?: string | undefined;
    },
  ): { success: boolean; diagnostics?: RootMotionDiagnostics; error?: string } {
    if (!this.#runtime) {
      const error = "Runtime is not running";
      this.#log("error", "animation.rootMotion.failed", { entityId, error });
      return { success: false, error };
    }

    const result = this.#runtime.configureRootMotion(entityId, options);
    if (!result.success) {
      this.#log("error", result.diagnostics?.code ?? "animation.rootMotion.failed", {
        entityId,
        error: result.error,
        ...(result.diagnostics?.hint ? { hint: result.diagnostics.hint } : {}),
      });
      return result;
    }

    this.#log("info", "animation.rootMotion.configured", {
      entityId,
      enabled: options.enabled,
      mode: options.mode ?? "extract-xz",
      rootBoneName: options.rootBoneName ?? "Hips",
    });
    return result;
  }

  async playAudio(options: PlayAudioOptions): Promise<PlayAudioResult> {
    const result = await this.#audio.play(options);
    if (result.success) {
      this.#log("info", "audio.played", {
        playbackId: result.playbackId,
        assetId: options.assetId,
        bus: options.bus ?? "master",
      });
    } else {
      this.#log("error", "audio.playFailed", {
        assetId: options.assetId,
        bus: options.bus,
        error: result.error,
      });
    }
    return result;
  }

  stopAudio(options: StopAudioOptions = {}): StopAudioResult {
    const result = this.#audio.stop(options);
    this.#log("info", "audio.stopped", {
      playbackId: options.playbackId,
      entityId: options.entityId,
      stoppedCount: result.stoppedCount,
    });
    return result;
  }

  setAudioBusGain(busId: string, gain: number): void {
    try {
      this.#audio.setBusGain(busId, gain);
      this.#log("info", "audio.busGainSet", { busId, gain });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.#log("error", "audio.busGainFailed", { busId, gain, error });
      throw err;
    }
  }

  setAudioBusMuted(busId: string, muted: boolean): void {
    try {
      this.#audio.setBusMuted(busId, muted);
      this.#log("info", "audio.busMutedSet", { busId, muted });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.#log("error", "audio.busMutedFailed", { busId, muted, error });
      throw err;
    }
  }

  detachModel(entityId: string): { success: boolean; error?: string } {

    if (!this.#runtime) {
      const error = "Runtime is not running";
      this.#log("error", "model.detachFailed", { entityId, error });
      return { success: false, error };
    }
    const result = this.#runtime.detachModel(entityId);
    if (result.success) {
      this.#log("info", "model.detached", { entityId });
    } else {
      this.#log("error", "model.detachFailed", { entityId, error: result.error });
    }
    return result;
  }

  async attachModel(
    entityId: string,
    assetId: string,
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.#runtime) {
      const error = "Runtime is not running";
      this.#log("error", "model.attachFailed", { entityId, assetId, error });
      return { success: false, error };
    }
    const result = await this.#runtime.attachModel(entityId, assetId, this.#assetResolver);
    if (result.success) {
      this.#log("info", "model.attached", { entityId, assetId });
    } else {
      this.#log("error", "model.attachFailed", { entityId, assetId, error: result.error });
    }
    return { success: result.success, ...(result.error ? { error: result.error } : {}) };
  }

  async reloadAsset(
    assetId: string,
  ): Promise<{ success: boolean; affectedEntities: string[]; error?: string }> {
    if (!this.#runtime) {
      const error = "Runtime is not running";
      this.#log("error", "asset.runtimeReloadFailed", { assetId, error });
      return { success: false, affectedEntities: [], error };
    }

    this.#log("info", "asset.runtimeReloadStarted", { assetId });
    const result = await this.#runtime.reloadAsset(assetId, this.#assetResolver);

    if (result.success) {
      this.#assetStatuses.set(assetId, "imported");
      if (result.droppedMorphOverrides) {
        this.#log("warning", "animation.morphOverridesDropped", {
          assetId,
          entities: result.droppedMorphOverrides,
        });
      }
      this.#log("info", "asset.runtimeReloadSucceeded", {
        assetId,
        affectedEntities: result.affectedEntities,
        newFingerprint: this.#assetFingerprints.get(assetId),
      });
    } else {
      this.#assetStatuses.set(assetId, "failed");
      this.#log("error", "asset.runtimeReloadFailed", {
        assetId,
        affectedEntities: result.affectedEntities,
        error: result.error,
      });
    }

    return {
      success: result.success,
      affectedEntities: result.affectedEntities,
      ...(result.error ? { error: result.error } : {}),
    };
  }

  async captureSave(slotId = "default"): Promise<{

    success: boolean;
    envelope?: SaveEnvelope<GameplaySaveData>;
    error?: string;
  }> {
    if (!this.#runtime) {
      const error = "Cannot capture save: Runtime is not running";
      this.#log("error", "save.captureFailed", { slotId, error });
      return { success: false, error };
    }

    // Prototype-less record: an entity id such as "__proto__" must stay an own key in the save.
    const entities: Record<string, EntitySaveState> = createKeyedRecord(
      Array.from(this.#runtime.objects(), ([entityId, obj]): [string, EntitySaveState] => {
        const execState = this.#scripts.getExecutionState(entityId);
        return [
          entityId,
          {
            position: [obj.position.x, obj.position.y, obj.position.z],
            rotation: [obj.rotation.x, obj.rotation.y, obj.rotation.z],
            ...(execState?.state ? { gameplay: structuredClone(execState.state) } : {}),
          },
        ];
      }),
    );

    const envelope: SaveEnvelope<GameplaySaveData> = {
      schemaVersion: CURRENT_SAVE_SCHEMA_VERSION,
      gameVersion: "0.1.0",
      slotId,
      savedAt: new Date().toISOString(),
      data: {
        sceneId: this.#runtime.sceneId,
        entities,
      },
    };

    await this.#saveStore.save(slotId, envelope);
    this.#log("info", "save.captured", {
      slotId,
      schemaVersion: envelope.schemaVersion,
      sceneId: envelope.data.sceneId,
      entityCount: Object.keys(entities).length,
    });

    return { success: true, envelope };
  }

  async getSave(
    slotId = "default",
  ): Promise<SaveEnvelope<GameplaySaveData> | undefined> {
    try {
      return await this.#saveStore.load(slotId);
    } catch {
      return undefined;
    }
  }

  async loadSave(options?: {
    slotId?: string;
    envelope?: SaveEnvelope;
  }): Promise<{
    success: boolean;
    slotId?: string;
    schemaVersion?: number;
    error?: string;
    phase?: "validation" | "migration" | "preparation" | "commit" | "rollback";
    rolledBack?: boolean;
    atomicityViolation?: boolean;
  }> {
    if (!this.#runtime) {
      const error = "Cannot load save: Runtime is not running";
      this.#log("error", "save.restoreFailed", { phase: "validation", error });
      return { success: false, error };
    }

    const slotId = options?.slotId ?? "default";
    let rawEnvelope = options?.envelope;
    if (!rawEnvelope) {
      try {
        rawEnvelope = await this.#saveStore.load(slotId);
      } catch (err) {
        const error = `Failed to read save document for slot "${slotId}": ${err instanceof Error ? err.message : String(err)}`;
        this.#log("error", "save.restoreFailed", { slotId, phase: "validation", error });
        return { success: false, slotId, error, phase: "validation" };
      }
    }

    if (!rawEnvelope) {
      const error = `Save document not found for slot "${slotId}"`;
      this.#log("error", "save.restoreFailed", { slotId, phase: "validation", error });
      return { success: false, slotId, error, phase: "validation" };
    }

    // Phase 1: Validation
    if (
      typeof rawEnvelope !== "object" ||
      rawEnvelope === null ||
      typeof (rawEnvelope as any).schemaVersion !== "number" ||
      typeof (rawEnvelope as any).data !== "object" ||
      (rawEnvelope as any).data === null
    ) {
      const error = "Invalid save envelope structure";
      this.#log("error", "save.restoreFailed", { slotId, phase: "validation", error });
      return { success: false, error };
    }

    // Phase 2: Migration
    let migratedEnvelope: SaveEnvelope<GameplaySaveData>;
    try {
      migratedEnvelope = this.#saveMigrator.migrate<GameplaySaveData>(
        rawEnvelope as SaveEnvelope,
      );
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.#log("error", "save.restoreFailed", { slotId, phase: "migration", error });
      return { success: false, error };
    }

    // Phase 3: Preparation & Target Validation (Preflight: apply nothing if any check fails)
    if (migratedEnvelope.data?.sceneId !== this.#runtime.sceneId) {
      const error = `Save sceneId "${migratedEnvelope.data?.sceneId}" does not match active sceneId "${this.#runtime.sceneId}"`;
      this.#log("error", "save.restoreFailed", {
        slotId,
        phase: "preparation",
        saveSceneId: migratedEnvelope.data?.sceneId,
        activeSceneId: this.#runtime.sceneId,
        error,
      });
      return { success: false, error };
    }

    if (
      !migratedEnvelope.data?.entities ||
      typeof migratedEnvelope.data.entities !== "object" ||
      Array.isArray(migratedEnvelope.data.entities)
    ) {
      const error = "Save contains invalid entities record";
      this.#log("error", "save.restoreFailed", { slotId, phase: "preparation", error });
      return { success: false, error };
    }

    interface PreparedTransform {
      entityId: string;
      obj: THREE.Object3D;
      position?: [number, number, number];
      rotation?: [number, number, number];
    }

    interface PreparedScript {
      entityId: string;
      restore: PreparedScriptRestore;
    }

    const preparedTransforms: PreparedTransform[] = [];
    const preparedScripts: PreparedScript[] = [];

    for (const [entityId, entry] of Object.entries(
      migratedEnvelope.data.entities,
    )) {
      const obj = this.#runtime.getObject(entityId);
      if (!obj) {
        const error = `Entity "${entityId}" from save does not exist in active scene`;
        this.#log("error", "save.restoreFailed", { slotId, entityId, phase: "preparation", error });
        return { success: false, error };
      }

      let prepPos: [number, number, number] | undefined;
      let prepRot: [number, number, number] | undefined;

      if (entry.position) {
        if (
          !Array.isArray(entry.position) ||
          entry.position.length !== 3 ||
          entry.position.some((v) => typeof v !== "number" || !Number.isFinite(v))
        ) {
          const error = `Invalid position coordinates for entity "${entityId}"`;
          this.#log("error", "save.restoreFailed", { slotId, entityId, phase: "preparation", error });
          return { success: false, error };
        }
        prepPos = [entry.position[0], entry.position[1], entry.position[2]];
      }

      if (entry.rotation) {
        if (
          !Array.isArray(entry.rotation) ||
          entry.rotation.length !== 3 ||
          entry.rotation.some((v) => typeof v !== "number" || !Number.isFinite(v))
        ) {
          const error = `Invalid rotation coordinates for entity "${entityId}"`;
          this.#log("error", "save.restoreFailed", { slotId, entityId, phase: "preparation", error });
          return { success: false, error };
        }
        prepRot = [entry.rotation[0], entry.rotation[1], entry.rotation[2]];
      }

      if (prepPos || prepRot) {
        preparedTransforms.push({
          entityId,
          obj,
          ...(prepPos ? { position: prepPos } : {}),
          ...(prepRot ? { rotation: prepRot } : {}),
        });
      }

      if (entry.gameplay) {
        if (
          typeof entry.gameplay !== "object" ||
          entry.gameplay === null ||
          Array.isArray(entry.gameplay)
        ) {
          const error = `Invalid gameplay payload for entity "${entityId}"`;
          this.#log("error", "save.restoreFailed", { slotId, entityId, phase: "preparation", error });
          return { success: false, error };
        }

        if (!this.#scripts.hasScript(entityId)) {
          const error = `Entity "${entityId}" has gameplay save state but no active script`;
          this.#log("error", "save.restoreFailed", { slotId, entityId, phase: "preparation", error });
          return { success: false, error };
        }

        if (!this.#scripts.canRestoreScriptState(entityId)) {
          const error = `Script on entity "${entityId}" does not support state restoration`;
          this.#log("error", "save.restoreFailed", { slotId, entityId, phase: "preparation", error });
          return { success: false, error };
        }

        if (!this.#scripts.canPrepareTransactionalRestore(entityId)) {
          const error = `Script on entity "${entityId}" does not support transactional state restoration`;
          this.#log("error", "save.restoreFailed", { slotId, entityId, phase: "preparation", error });
          return { success: false, error };
        }

        const validation = this.#scripts.validateScriptRestoreState(
          entityId,
          entry.gameplay,
        );
        if (!validation.valid) {
          const error = `Invalid gameplay state for entity "${entityId}": ${validation.error ?? "Validation failed"}`;
          this.#log("error", "save.restoreFailed", { slotId, entityId, phase: "preparation", error });
          return { success: false, error };
        }

        const preparedRestore = await this.#scripts.prepareScriptRestore(
          entityId,
          entry.gameplay,
        );

        preparedScripts.push({
          entityId,
          restore: preparedRestore,
        });
      }
    }

    // Phase 4: Transactional Commit with Strict Invariant Verification
    const rollbackTransforms: Array<{
      entityId: string;
      obj: THREE.Object3D;
      position: [number, number, number];
      rotation: [number, number, number];
    }> = preparedTransforms.map((p) => ({
      entityId: p.entityId,
      obj: p.obj,
      position: [p.obj.position.x, p.obj.position.y, p.obj.position.z],
      rotation: [p.obj.rotation.x, p.obj.rotation.y, p.obj.rotation.z],
    }));

    const priorScriptStates = new Map<string, Record<string, unknown> | undefined>();
    for (const p of preparedScripts) {
      const exec = this.#scripts.getExecutionState(p.entityId);
      priorScriptStates.set(
        p.entityId,
        exec?.state ? (structuredClone(exec.state) as Record<string, unknown>) : undefined,
      );
    }

    const committedRestores: Array<{
      entityId: string;
      restore: PreparedScriptRestore;
    }> = [];

    let rollbackError: string | undefined;

    try {
      // 1. Commit all prepared transforms
      for (const prep of preparedTransforms) {
        if (prep.position) {
          prep.obj.position.set(
            prep.position[0],
            prep.position[1],
            prep.position[2],
          );
          if (this.#physics?.hasBody(prep.entityId)) {
            this.#physics.setBodyTranslation(
              prep.entityId,
              { x: prep.position[0], y: prep.position[1], z: prep.position[2] },
              true,
            );
          }
        }
        if (prep.rotation) {
          prep.obj.rotation.set(
            prep.rotation[0],
            prep.rotation[1],
            prep.rotation[2],
          );
        }
      }

      // 2. Commit all prepared script states
      for (const prep of preparedScripts) {
        try {
          await prep.restore.commit();
          committedRestores.push(prep);
        } catch (scriptErr) {
          // Even if this script threw during commit, it may have partially mutated state.
          // Rollback this script immediately as well:
          try {
            await prep.restore.rollback();
          } catch (rbErr) {
            const rbMsg =
              rbErr instanceof Error ? rbErr.message : String(rbErr);
            rollbackError = rollbackError
              ? `${rollbackError}; ${rbMsg}`
              : rbMsg;
          }
          throw scriptErr;
        }
      }
    } catch (commitErr) {
      const rawCommitError =
        commitErr instanceof Error ? commitErr.message : String(commitErr);

      // 1. Rollback all modified transforms
      try {
        for (const rollback of rollbackTransforms) {
          rollback.obj.position.set(
            rollback.position[0],
            rollback.position[1],
            rollback.position[2],
          );
          rollback.obj.rotation.set(
            rollback.rotation[0],
            rollback.rotation[1],
            rollback.rotation[2],
          );
          if (this.#physics?.hasBody(rollback.entityId)) {
            this.#physics.setBodyTranslation(
              rollback.entityId,
              { x: rollback.position[0], y: rollback.position[1], z: rollback.position[2] },
              true,
            );
          }
        }
      } catch (err) {
        rollbackError = err instanceof Error ? err.message : String(err);
      }

      // 2. Rollback all committed scripts in reverse order
      for (const committed of [...committedRestores].reverse()) {
        try {
          await committed.restore.rollback();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          rollbackError = rollbackError ? `${rollbackError}; ${msg}` : msg;
        }
      }

      // 3. Strict post-rollback verification:
      // Verify transforms
      for (const rollback of rollbackTransforms) {
        if (
          rollback.obj.position.x !== rollback.position[0] ||
          rollback.obj.position.y !== rollback.position[1] ||
          rollback.obj.position.z !== rollback.position[2] ||
          rollback.obj.rotation.x !== rollback.rotation[0] ||
          rollback.obj.rotation.y !== rollback.rotation[1] ||
          rollback.obj.rotation.z !== rollback.rotation[2]
        ) {
          rollbackError = rollbackError
            ? `${rollbackError}; Transform position/rotation did not match pre-transaction snapshot`
            : "Transform position/rotation did not match pre-transaction snapshot";
        }
      }

      // Verify script states
      for (const [entityId, priorState] of priorScriptStates.entries()) {
        const currentExec = this.#scripts.getExecutionState(entityId);
        const currentState = currentExec?.state;
        if (priorState !== undefined) {
          if (!isEqualJson(currentState, priorState)) {
            const mismatchMsg = `Script state for entity "${entityId}" did not match pre-transaction snapshot (expected ${JSON.stringify(priorState)}, got ${JSON.stringify(currentState)})`;
            rollbackError = rollbackError ? `${rollbackError}; ${mismatchMsg}` : mismatchMsg;
          }
        }
      }

      if (rollbackError) {
        const error = `Rollback failed: atomicity invariant violated: ${rollbackError} (original commit error: ${rawCommitError})`;
        this.#log("error", "save.restoreFailed", {
          slotId,
          phase: "rollback",
          rolledBack: false,
          atomicityViolation: true,
          error,
        });
        return {
          success: false,
          phase: "rollback",
          rolledBack: false,
          atomicityViolation: true,
          error,
        };
      }

      // Rollback verified complete and identical to pre-load state
      const error = `Commit failed and was rolled back: ${rawCommitError}`;
      this.#log("error", "save.restoreFailed", {
        slotId,
        phase: "commit",
        rolledBack: true,
        error,
      });
      return {
        success: false,
        phase: "commit",
        rolledBack: true,
        error,
      };
    }

    this.renderOnce();
    this.#log("info", "save.restored", {
      slotId,
      schemaVersion: migratedEnvelope.schemaVersion,
      sceneId: migratedEnvelope.data.sceneId,
      entityCount: Object.keys(migratedEnvelope.data.entities).length,
    });

    return {
      success: true,
      slotId,
      schemaVersion: migratedEnvelope.schemaVersion,
    };
  }

  query(query: PlayerRuntimeQuery = {}): PlayerRuntimeQueryResult {
    if (!this.#runtime) {
      return {
        running: false,
        entities: [],
        audio: this.#audio.getState(),
        shell: { mode: this.#shellMode, isPaused: this.#paused },
        renderer: {
          captureMode: this.captureMode,
          preserveDrawingBuffer: this.preserveDrawingBuffer,
        },
      };
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
      const executionState = this.#scripts.getExecutionState(entityId);
      const unresolved = this.#unresolvedScripts.get(entityId);

      let gameplay: PlayerRuntimeGameplayState | undefined;
      if (executionState) {
        gameplay = {
          scriptId: executionState.scriptId ?? "unknown",
          lifecycleState: executionState.lifecycleState,
          updateCount: executionState.updateCount,
          ...(executionState.state !== undefined ? { state: executionState.state } : {}),
          ...(executionState.error !== undefined ? { error: executionState.error } : {}),
        };
      } else if (unresolved) {
        gameplay = {
          scriptId: unresolved.scriptId,
          lifecycleState: "error",
          updateCount: 0,
          error: unresolved.error,
        };
      }

      const rootMotionMeta = modelMeta?.animation?.rootMotion;
      if (rootMotionMeta) {
        if (!gameplay) {
          gameplay = {
            scriptId: "rootMotion",
            lifecycleState: "started",
            updateCount: 0,
            rootMotion: rootMotionMeta,
          };
        } else {
          gameplay.rootMotion = rootMotionMeta;
        }
      }

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
                ...(modelMeta.skinnedMeshCount !== undefined
                  ? { skinnedMeshCount: modelMeta.skinnedMeshCount }
                  : {}),
                ...(modelMeta.hasSkin !== undefined
                  ? { hasSkin: modelMeta.hasSkin }
                  : {}),
                ...(modelMeta.bounds ? { bounds: modelMeta.bounds } : {}),
                ...(modelMeta.animation ? { animation: modelMeta.animation } : {}),
                ...(modelMeta.nodes ? { nodes: modelMeta.nodes } : {}),
                ...(modelMeta.morphTargets ? { morphTargets: modelMeta.morphTargets } : {}),
                ...(modelMeta.instance ? { instance: modelMeta.instance } : {}),
                ...(modelMeta.resourceSharing ? { resourceSharing: modelMeta.resourceSharing } : {}),
                ...(modelMeta.assetFingerprint ? { assetFingerprint: modelMeta.assetFingerprint } : {}),
                ...(modelMeta.templateRevision !== undefined ? { templateRevision: modelMeta.templateRevision } : {}),
                ...(modelMeta.error ? { error: modelMeta.error } : {}),
              },
            }
          : {}),
        ...(gameplay ? { gameplay } : {}),
      });
    }

    entities.sort((left, right) => compareCodeUnits(left.entityId, right.entityId));

    // Game-level state comes from the running game's module (Arena: its session).
    const activeSession = this.#activeGame?.readGameState?.(entities);

    if (activeSession) {
      if (activeSession.status === "won" && this.#shellMode === "playing") {
        this.#shellMode = "won";
      } else if (activeSession.status === "lost" && this.#shellMode === "playing") {
        this.#shellMode = "lost";
      }
    }

    return {
      running: true,
      ...(this.#activeGame ? { gameId: this.#activeGame.id } : {}),
      sceneId: this.#runtime.sceneId,
      ...(this.#projectRevision !== undefined
        ? { projectRevision: this.#projectRevision }
        : {}),
      entities,
      navigation: structuredClone(this.#navigationState),
      audio: this.#audio.getState(),
      ...(activeSession
        ? { gameplay: { session: activeSession }, game: activeSession }
        : {}),
      shell: { mode: this.#shellMode, isPaused: this.#paused },
      metrics: {
        assetTemplateParseCount: this.#runtime?.assetTemplateParseCount ?? 0,
        instanceCount: this.#runtime?.instanceCount ?? 0,
      },
      renderer: {
        captureMode: this.captureMode,
        preserveDrawingBuffer: this.preserveDrawingBuffer,
      },
      assets: this.#getAssetsQueryState(),
    };
  }

  #getAssetsQueryState(): PlayerRuntimeAssetsQueryState {
    // Prototype-less record: an asset id such as "__proto__" must stay an own key in the query.
    const byId: Record<string, PlayerRuntimeAssetQueryInfo> = createKeyedRecord(
      Array.from(this.#assetRegistry.keys(), (assetId): [string, PlayerRuntimeAssetQueryInfo] => [
        assetId,
        {
          assetId,
          ...(this.#assetSourceHashes.has(assetId) ? { sourceHash: this.#assetSourceHashes.get(assetId) } : {}),
          ...(this.#assetFingerprints.has(assetId) ? { fingerprint: this.#assetFingerprints.get(assetId) } : {}),
          importStatus: this.#assetStatuses.get(assetId) ?? "imported",
          ...(this.#assetRevisions.has(assetId) ? { revision: this.#assetRevisions.get(assetId) } : {}),
        },
      ]),
    );
    return { byId };
  }


  injectInput(event: PlayerRuntimeInput): void {
    if (!this.#runtime) {
      throw new Error("Runtime is not running");
    }

    if (event.action === "game.pause") {
      if (event.phase === "press") {
        this.togglePause();
      }
      this.#log("debug", "runtime.input", {
        action: event.action,
        phase: event.phase,
        isPaused: this.#paused,
      });
      return;
    }

    if (this.#paused) {
      this.#log("debug", "runtime.inputBlockedWhilePaused", {
        action: event.action,
        phase: event.phase,
      });
      return;
    }

    const rawValue = event.value;
    const magnitude =
      typeof rawValue === "number"
        ? rawValue
        : Array.isArray(rawValue) && typeof rawValue[0] === "number"
          ? rawValue[0]
          : 1;

    this.#inputRouter.setSemanticAction(event.action, event.phase, magnitude);

    let displacementActual: number | undefined;

    if (this.#physics) {
      const characterIds = this.#physics.characterIds();

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

  #updateRootMotion(fixedDeltaSeconds: number): void {
    if (!this.#runtime) return;

    for (const [entityId, object] of this.#runtime.objects()) {
      const session = this.#runtime.getAnimatorSession(entityId);
      if (!session?.rootMotion?.enabled) continue;

      // Negative proof: check if entity has a character controller in physics
      if (!this.#physics || !this.#physics.characterIds().includes(entityId)) {
        const code = "animation.rootMotion.physicsUnsupported";
        const message = `Entity "${entityId}" does not have a character controller in physics world`;
        const hint = "Add a CharacterBody and Collider component to the entity before enabling root motion";
        this.#log("error", code, { entityId, error: message, hint });
        continue;
      }

      // Propose displacement from animation
      const requested = this.#runtime.sampleRootMotion(entityId, fixedDeltaSeconds);
      const reqTrans = requested.translation;
      const reqYaw = requested.yaw;

      // Rotate requested delta by current character Y rotation into world coordinates
      const curRotY = object.rotation.y;
      const cosY = Math.cos(curRotY);
      const sinY = Math.sin(curRotY);
      const worldDx = reqTrans[0] * cosY + reqTrans[2] * sinY;
      const worldDz = -reqTrans[0] * sinY + reqTrans[2] * cosY;
      const worldDy = reqTrans[1];

      const worldDesired = { x: worldDx, y: worldDy, z: worldDz };

      // Character motor / collision resolution in Rapier
      let actual = { x: 0, y: 0, z: 0 };
      let collided = false;

      if (worldDesired.x !== 0 || worldDesired.y !== 0 || worldDesired.z !== 0) {
        const moveRes = this.#physics.moveCharacter(entityId, worldDesired);
        actual = moveRes.actual;
        collided = moveRes.collided;
        this.#syncTransformsFromPhysics();
      }

      let appliedYaw = 0;
      if (reqYaw !== 0) {
        appliedYaw = reqYaw;
        object.rotation.y += appliedYaw;
      }

      const blockedDelta: [number, number, number] = [
        worldDesired.x - actual.x,
        worldDesired.y - actual.y,
        worldDesired.z - actual.z,
      ];

      this.#runtime.recordRootMotionResult(entityId, {
        requestedDelta: [worldDesired.x, worldDesired.y, worldDesired.z],
        appliedDelta: [actual.x, actual.y, actual.z],
        blockedDelta,
        requestedYaw: reqYaw,
        appliedYaw,
        collisionClipped: collided,
      });
    }
  }

  step(steps = 1, fixedDeltaSeconds = 1 / 60): void {
    this.#stepped = true;
    for (let s = 0; s < steps; s++) {
      if (!this.#paused) {
        this.#scripts.update(fixedDeltaSeconds);
        this.#updateRootMotion(fixedDeltaSeconds);
        if (this.#physics) {
          this.#physics.step(fixedDeltaSeconds);
          this.#syncTransformsFromPhysics();
        }
        if (this.#runtime) {
          this.#runtime.updateAnimation(fixedDeltaSeconds);
        }
      }
      this.#inputRouter.endStep();
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

  captureFrameBase64(): string {
    this.renderOnce();
    const dataUrl = this.canvas.toDataURL("image/png");
    return dataUrl.replace(/^data:image\/png;base64,/, "");
  }

  async samplePerformance(options: {
    warmupFrames?: number;
    sampleFrames?: number;
    fixedDeltaSeconds?: number;
    mode?: "stepped" | "continuous";
  } = {}): Promise<PlayerRuntimePerformanceEvidence> {
    const warmupFrames = options.warmupFrames ?? 10;
    const sampleFrames = options.sampleFrames ?? 60;
    const fixedDeltaSeconds = options.fixedDeltaSeconds ?? 1 / 60;
    const mode = options.mode === "continuous" ? "continuous" : "stepped";

    // 1. Warm-up frames (unmeasured)
    for (let i = 0; i < warmupFrames; i++) {
      if (!this.#paused) {
        this.#scripts.update(fixedDeltaSeconds);
        this.#updateRootMotion(fixedDeltaSeconds);
        if (this.#physics) {
          this.#physics.step(fixedDeltaSeconds);
          this.#syncTransformsFromPhysics();
        }
        if (this.#runtime) {
          this.#runtime.updateAnimation(fixedDeltaSeconds);
        }
      }
      this.#inputRouter.endStep();
      this.renderOnce();
    }

    // 2. Measured sample frames
    const frameSamples: number[] = [];
    const simSamples: number[] = [];
    const renderSamples: number[] = [];

    let peakCalls = 0;
    let peakTriangles = 0;
    let peakPoints = 0;
    let peakLines = 0;

    for (let i = 0; i < sampleFrames; i++) {
      const simStart = performance.now();
      if (!this.#paused) {
        this.#scripts.update(fixedDeltaSeconds);
        this.#updateRootMotion(fixedDeltaSeconds);
        if (this.#physics) {
          this.#physics.step(fixedDeltaSeconds);
          this.#syncTransformsFromPhysics();
        }
        if (this.#runtime) {
          this.#runtime.updateAnimation(fixedDeltaSeconds);
        }
      }
      this.#inputRouter.endStep();
      const simMs = Math.max(0, performance.now() - simStart);

      const renderStart = performance.now();
      this.renderOnce();
      const renderMs = Math.max(0, performance.now() - renderStart);

      const frameMs = simMs + renderMs;

      simSamples.push(simMs);
      renderSamples.push(renderMs);
      frameSamples.push(frameMs);

      const calls = this.renderer.info.render.calls;
      const triangles = this.renderer.info.render.triangles;
      const points = this.renderer.info.render.points;
      const lines = this.renderer.info.render.lines;

      if (calls > peakCalls) peakCalls = calls;
      if (triangles > peakTriangles) peakTriangles = triangles;
      if (points > peakPoints) peakPoints = points;
      if (lines > peakLines) peakLines = lines;
    }

    const sceneMetrics = this.#runtime?.getSceneMetrics() ?? {
      objectCount: 0,
      visibleObjectCount: 0,
      modelInstanceCount: 0,
      skinnedMeshCount: 0,
      activeAnimationMixerCount: 0,
    };

    const physicsMetrics = this.#physics
      ? {
          bodyCount: this.#physics.stats().bodies,
          colliderCount: this.#physics.stats().colliders,
        }
      : undefined;

    return {
      sampleCount: sampleFrames,
      warmupSamples: warmupFrames,
      executionMode: mode,
      frame: calculatePercentiles(frameSamples),
      simulation: calculatePercentiles(simSamples),
      render: calculatePercentiles(renderSamples),
      renderer: {
        drawCalls: peakCalls,
        triangles: peakTriangles,
        points: peakPoints,
        lines: peakLines,
        geometries: this.renderer.info.memory.geometries,
        textures: this.renderer.info.memory.textures,
      },
      scene: sceneMetrics,
      ...(physicsMetrics ? { physics: physicsMetrics } : {}),
    };
  }

  frame(deltaSeconds = 1 / 60): void {
    if (!this.#stepped) {
      const pad = this.#gamepadProvider.getSnapshot();
      const snapshot: PhysicalInputSnapshot = {
        keys: this.#activeKeys,
        gamepadButtons: pad?.buttons ?? [],
        gamepadAxes: pad?.axes ?? [],
      };

      const pausePressed = this.#inputRouter.isActionPressed("game.pause", snapshot);
      if (pausePressed && !this.#lastPausePressed) {
        this.togglePause();
      }
      this.#lastPausePressed = pausePressed;

      if (!this.#paused) {
        this.#scripts.update(deltaSeconds);
        if (this.#physics) {
          this.#physics.advance(deltaSeconds);
          this.#syncTransformsFromPhysics();
        }
        if (this.#runtime) {
          this.#runtime.updateAnimation(deltaSeconds);
        }
      }
      this.#inputRouter.endStep();
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

function calculatePercentiles(samples: number[]): PlayerRuntimePerformanceTiming {
  if (samples.length === 0) {
    return { p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0 };
  }

  const sorted = [...samples].sort((a, b) => a - b);

  const getPercentile = (p: number): number => {
    if (sorted.length === 1) {
      return sorted[0]!;
    }
    const index = (p / 100) * (sorted.length - 1);
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    const weight = index - lower;
    return sorted[lower]! * (1 - weight) + sorted[upper]! * weight;
  };

  return {
    p50Ms: Number(getPercentile(50).toFixed(3)),
    p95Ms: Number(getPercentile(95).toFixed(3)),
    p99Ms: Number(getPercentile(99).toFixed(3)),
    maxMs: Number(sorted[sorted.length - 1]!.toFixed(3)),
  };
}
