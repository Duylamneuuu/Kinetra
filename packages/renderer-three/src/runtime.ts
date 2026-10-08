import type {
  EntityDefinition,
  ProjectDocument,
  SceneDefinition,
} from "@kinetra/project-model";
import {
  AnimationGraphMachine,
  validateAnimationGraph,
  type AnimationGraphDefinition,
  type AnimationGraphDiagnostic,
  type AnimationTransitionResult,
} from "@kinetra/animation/graph.js";
import {
  extractRootMotionFromClip,
  computeRootMotionStepDelta,
  type RootMotionMode,
  type RootMotionFrameDelta,
  type ExtractedClipRootMotion,
  type RootMotionDiagnostics,
} from "@kinetra/animation/root-motion.js";
import type {
  BlendSpaceDefinition,
  BlendSpaceDiagnostic,
} from "@kinetra/animation/blend-space.js";
import * as THREE from "three";

import {
  BlendSpacePlayback,
  type BlendSpacePlaybackState,
} from "./blend-space-player.js";
import {
  MorphTargetController,
  type MorphClearResult,
  type MorphSetResult,
} from "./morph.js";

import type { AssetResolver, ModelMetadata, ModelNodeState } from "./assets.js";
import { asObject, numberValue, stringValue, vec3Value } from "./components.js";
import {
  ModelAssetTemplate,
  ModelInstance,
  ModelTemplateCache,
} from "./template.js";


export interface AnimatorBlendSession {
  fromClip: string;
  toClip: string;
  fromState?: string | undefined;
  toState?: string | undefined;
  transitionId?: string | undefined;
  blendSeconds: number;
  blendElapsed: number;
  fromInitialWeight: number;
}

export interface EntityRootMotionSession {
  enabled: boolean;
  mode: RootMotionMode;
  rootBoneName: string;
  sourceClipName?: string | undefined;
  extracted?: ExtractedClipRootMotion | undefined;
  playbackTime: number;
  accumulatedDistance: number;
  lastRequestedDelta: [number, number, number];
  lastAppliedDelta: [number, number, number];
  lastBlockedDelta: [number, number, number];
  lastRequestedYaw: number;
  lastAppliedYaw: number;
  lastCollisionClipped: boolean;
  error?: RootMotionDiagnostics | undefined;
}

export interface EntityAnimatorSession {
  entityId: string;
  mixer: THREE.AnimationMixer;
  activeAction?: THREE.AnimationAction | undefined;
  activeClipName?: string | undefined;
  outgoingAction?: THREE.AnimationAction | undefined;
  outgoingClipName?: string | undefined;
  blend?: AnimatorBlendSession | undefined;
  graphMachine?: AnimationGraphMachine | undefined;
  graphDefinition?: AnimationGraphDefinition | undefined;
  previousGraphState?: string | undefined;
  lastTransitionId?: string | undefined;
  retargetSource?: string | undefined;
  retargetCacheKey?: string | undefined;
  rootMotion?: EntityRootMotionSession | undefined;
  /** Active locomotion blend space; mutually exclusive with active/outgoing actions. */
  blendSpace?: BlendSpacePlayback | undefined;
}

export interface BlendSpaceRuntimeResult {
  success: boolean;
  code?: string | undefined;
  error?: string | undefined;
  diagnostics?: BlendSpaceDiagnostic[] | undefined;
  state?: BlendSpacePlaybackState | undefined;
}

export interface ThreeSceneMetrics {
  objectCount: number;
  visibleObjectCount: number;
  modelInstanceCount: number;
  skinnedMeshCount: number;
  activeAnimationMixerCount: number;
}

function makeObject(entity: EntityDefinition): THREE.Object3D {
  const camera = asObject(entity.components.Camera);
  if (camera) {
    const type = stringValue(camera.type, "perspective");
    if (type !== "perspective") {
      throw new Error(`Unsupported Camera.type "${type}" for entity "${entity.id}"`);
    }

    return new THREE.PerspectiveCamera(
      numberValue(camera.fov, 60),
      numberValue(camera.aspect, 16 / 9),
      numberValue(camera.near, 0.1),
      numberValue(camera.far, 2000),
    );
  }

  const light = asObject(entity.components.Light);
  if (light) {
    const kind = stringValue(light.kind, "directional");
    const color = new THREE.Color(stringValue(light.color, "#ffffff"));
    const intensity = numberValue(light.intensity, 1);

    switch (kind) {
      case "ambient":
        return new THREE.AmbientLight(color, intensity);
      case "point":
        return new THREE.PointLight(color, intensity);
      case "directional":
        return new THREE.DirectionalLight(color, intensity);
      default:
        throw new Error(`Unsupported Light.kind "${kind}" for entity "${entity.id}"`);
    }
  }

  const primitive = makePrimitive(entity);
  if (primitive) {
    return primitive;
  }

  return new THREE.Group();
}

function makePrimitive(entity: EntityDefinition): THREE.Object3D | null {
  const primitive = asObject(entity.components.Primitive);
  if (!primitive) {
    return null;
  }

  const kind = stringValue(primitive.kind, "box");
  const color = new THREE.Color(stringValue(primitive.color, "#d9e6ff"));
  const roughness = numberValue(primitive.roughness, 0.5);
  const metalness = numberValue(primitive.metalness, 0.1);
  const material = new THREE.MeshStandardMaterial({
    color,
    roughness,
    metalness,
  });

  let geometry: THREE.BufferGeometry;
  switch (kind) {
    case "box": {
      const size = vec3Value(primitive.size, [1, 1, 1]);
      geometry = new THREE.BoxGeometry(size[0], size[1], size[2]);
      break;
    }
    case "sphere": {
      const radius = numberValue(primitive.radius, 0.5);
      const segments = Math.max(8, Math.floor(numberValue(primitive.segments, 24)));
      geometry = new THREE.SphereGeometry(radius, segments, segments);
      break;
    }
    case "plane": {
      const width = numberValue(primitive.width, 10);
      const height = numberValue(primitive.height, 10);
      geometry = new THREE.PlaneGeometry(width, height);
      break;
    }
    default:
      throw new Error(`Unsupported Primitive.kind "${kind}" for entity "${entity.id}"`);
  }

  return new THREE.Mesh(geometry, material);
}

function applyTransform(object: THREE.Object3D, entity: EntityDefinition): void {
  const transform = asObject(entity.components.Transform);
  if (!transform) {
    return;
  }

  const position = vec3Value(transform.position, [0, 0, 0]);
  const rotation = vec3Value(transform.rotation, [0, 0, 0]);
  const scale = vec3Value(transform.scale, [1, 1, 1]);

  object.position.set(...position);
  object.rotation.set(...rotation);
  object.scale.set(...scale);
}

function decorateObject(object: THREE.Object3D, entity: EntityDefinition): void {
  object.name = entity.name;
  object.userData.kinetra = { entityId: entity.id };

  const model = asObject(entity.components.Model);
  if (model) {
    const assetId = model.assetId;
    if (typeof assetId === "string") {
      object.userData.kinetraModel = { assetId };
    }
  }
}

function disposeMaterial(material: THREE.Material | undefined): void {
  if (!material) return;
  for (const value of Object.values(material)) {
    if (value instanceof THREE.Texture) {
      value.dispose();
    }
  }
  material.dispose();
}

function disposeObjectResources(object: THREE.Object3D): void {
  object.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.geometry?.dispose();
      if (Array.isArray(child.material)) {
        for (const mat of child.material) {
          disposeMaterial(mat);
        }
      } else {
        disposeMaterial(child.material);
      }
      if (child instanceof THREE.SkinnedMesh) {
        child.skeleton?.dispose();
      }
    }
  });
}

export class ThreeSceneRuntime {
  readonly scene = new THREE.Scene();
  readonly sceneId: string;
  #objects = new Map<string, THREE.Object3D>();
  #models = new Map<string, ModelMetadata>();
  #modelScenes = new Map<string, THREE.Group>();
  #mixers = new Map<string, THREE.AnimationMixer>();
  #clips = new Map<string, THREE.AnimationClip[]>();
  #activeActions = new Map<string, THREE.AnimationAction>();
  #animatorSessions = new Map<string, EntityAnimatorSession>();
  #templateCache = new ModelTemplateCache();
  #instances = new Map<string, ModelInstance>();
  #morphControllers = new Map<string, MorphTargetController>();
  #disposed = false;


  private constructor(sceneDefinition: SceneDefinition) {
    this.sceneId = sceneDefinition.id;
    this.scene.name = sceneDefinition.name;

    for (const entity of sceneDefinition.entities) {
      const object = makeObject(entity);
      applyTransform(object, entity);
      decorateObject(object, entity);
      this.#objects.set(entity.id, object);

      const modelComp = asObject(entity.components.Model);
      if (modelComp && typeof modelComp.assetId === "string") {
        this.#models.set(entity.id, {
          assetId: modelComp.assetId,
          loaded: false,
          meshCount: 0,
          nodeCount: 0,
        });
      }
    }

    for (const entity of sceneDefinition.entities) {
      const object = this.#objects.get(entity.id);
      if (!object) {
        throw new Error(`Runtime object missing for entity "${entity.id}"`);
      }

      if (entity.parentId) {
        const parent = this.#objects.get(entity.parentId);
        if (!parent) {
          throw new Error(`Runtime parent "${entity.parentId}" missing for "${entity.id}"`);
        }
        parent.add(object);
      } else {
        this.scene.add(object);
      }
    }
  }

  static instantiate(project: ProjectDocument, sceneId: string): ThreeSceneRuntime {
    const scene = project.scenes.find((candidate) => candidate.id === sceneId);
    if (!scene) {
      throw new Error(`Scene "${sceneId}" does not exist`);
    }
    return new ThreeSceneRuntime(scene);
  }

  static async instantiateAsync(
    project: ProjectDocument,
    sceneId: string,
    options: { assetResolver?: AssetResolver } = {},
  ): Promise<ThreeSceneRuntime> {
    const runtime = ThreeSceneRuntime.instantiate(project, sceneId);
    if (options.assetResolver) {
      await runtime.loadModels(options.assetResolver);
    }
    return runtime;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  getObject(entityId: string): THREE.Object3D | undefined {
    return this.#objects.get(entityId);
  }

  objects(): ReadonlyMap<string, THREE.Object3D> {
    return this.#objects;
  }

  getModelMetadata(entityId: string): ModelMetadata | undefined {
    return this.#models.get(entityId);
  }

  models(): ReadonlyMap<string, ModelMetadata> {
    return this.#models;
  }

  get assetTemplateParseCount(): number {
    return this.#templateCache.parseCount;
  }

  get instanceCount(): number {
    return this.#instances.size;
  }

  getInstance(entityId: string): ModelInstance | undefined {
    return this.#instances.get(entityId);
  }

  getSceneMetrics(): ThreeSceneMetrics {
    let objectCount = 0;
    let visibleObjectCount = 0;
    let skinnedMeshCount = 0;

    this.scene.traverse((obj) => {
      if (obj !== this.scene) {
        objectCount++;
        if (obj.visible) {
          visibleObjectCount++;
        }
        if ((obj as THREE.SkinnedMesh).isSkinnedMesh) {
          skinnedMeshCount++;
        }
      }
    });

    return {
      objectCount,
      visibleObjectCount,
      modelInstanceCount: this.#instances.size,
      skinnedMeshCount,
      activeAnimationMixerCount: this.#mixers.size,
    };
  }

  getTemplateCache(): ModelTemplateCache {
    return this.#templateCache;
  }

  async loadModels(resolver: AssetResolver): Promise<Map<string, ModelMetadata>> {
    if (this.#disposed) {
      throw new Error("Cannot load models into a disposed ThreeSceneRuntime");
    }

    const entries = Array.from(this.#models.entries());
    await Promise.all(
      entries.map(async ([entityId, metadata]) => {
        const object = this.#objects.get(entityId);
        if (!object) {
          return;
        }

        try {
          const template = await this.#templateCache.resolveTemplate(metadata.assetId, resolver);
          const instance = template.createInstance(entityId);
          this.#instances.set(entityId, instance);
          this.#attachInstance(entityId, object, instance, metadata);
        } catch (error) {
          metadata.loaded = false;
          metadata.error = error instanceof Error ? error.message : String(error);
        }
      }),
    );

    this.#updateResourceSharingMetadata();
    return this.#models;
  }

  async attachModel(
    entityId: string,
    assetId: string,
    resolver: AssetResolver,
  ): Promise<{ success: boolean; error?: string; metadata?: ModelMetadata }> {
    if (this.#disposed) {
      return { success: false, error: "Cannot attach model to a disposed ThreeSceneRuntime" };
    }

    const object = this.#objects.get(entityId);
    if (!object) {
      return { success: false, error: `Entity "${entityId}" not found in runtime` };
    }

    if (this.#instances.has(entityId)) {
      this.detachModel(entityId);
    }

    let metadata = this.#models.get(entityId);
    if (!metadata) {
      metadata = {
        assetId,
        loaded: false,
        meshCount: 0,
        nodeCount: 0,
      };
      this.#models.set(entityId, metadata);
    } else {
      metadata.assetId = assetId;
    }

    try {
      const template = await this.#templateCache.resolveTemplate(assetId, resolver);
      const instance = template.createInstance(entityId);
      this.#instances.set(entityId, instance);
      this.#attachInstance(entityId, object, instance, metadata);
      this.#updateResourceSharingMetadata();
      return { success: true, metadata };
    } catch (error) {
      metadata.loaded = false;
      metadata.error = error instanceof Error ? error.message : String(error);
      return { success: false, error: metadata.error };
    }
  }

  detachModel(entityId: string): { success: boolean; error?: string } {
    if (this.#disposed) {
      return { success: false, error: "Runtime is disposed" };
    }

    const session = this.#animatorSessions.get(entityId);
    if (session) {
      if (session.outgoingAction) session.outgoingAction.stop();
      if (session.activeAction) session.activeAction.stop();
      session.blendSpace?.stop();
      session.mixer.stopAllAction();
      const modelScene = this.#modelScenes.get(entityId);
      if (modelScene) {
        session.mixer.uncacheRoot(modelScene);
      }
      const clips = this.#clips.get(entityId);
      if (clips) {
        for (const clip of clips) {
          session.mixer.uncacheClip(clip);
        }
      }
    }
    this.#animatorSessions.delete(entityId);
    this.#mixers.delete(entityId);
    this.#clips.delete(entityId);
    this.#activeActions.delete(entityId);
    this.#modelScenes.delete(entityId);
    this.#morphControllers.delete(entityId);

    const instance = this.#instances.get(entityId);
    if (instance) {
      instance.dispose();
      this.#instances.delete(entityId);
    }

    const metadata = this.#models.get(entityId);
    if (metadata) {
      metadata.loaded = false;
      delete metadata.animation;
      delete metadata.nodes;
      delete metadata.morphTargets;
      delete metadata.bounds;
      delete metadata.instance;
      delete metadata.resourceSharing;
      delete metadata.assetFingerprint;
      delete metadata.templateRevision;
    }

    this.#updateResourceSharingMetadata();
    return { success: true };
  }

  async reloadAsset(
    assetId: string,
    resolver: AssetResolver,
  ): Promise<{
    success: boolean;
    affectedEntities: string[];
    error?: string | undefined;
    /** Entity -> morph overrides the reloaded asset no longer supports. */
    droppedMorphOverrides?: Record<string, string[]> | undefined;
  }> {
    if (this.#disposed) {
      return { success: false, affectedEntities: [], error: "Runtime is disposed" };
    }

    const affectedEntities: string[] = [];
    for (const [entityId, meta] of this.#models) {
      if (meta.assetId === assetId) {
        affectedEntities.push(entityId);
      }
    }

    const droppedMorphOverrides: Record<string, string[]> = {};
    let newTemplate: ModelAssetTemplate;
    try {
      newTemplate = await this.#templateCache.resolveNewTemplate(assetId, resolver);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return { success: false, affectedEntities, error: errorMsg };
    }

    for (const entityId of affectedEntities) {
      const object = this.#objects.get(entityId);
      if (!object) continue;
      const metadata = this.#models.get(entityId);
      if (!metadata) continue;

      const oldInstance = this.#instances.get(entityId);
      const oldModelScene = this.#modelScenes.get(entityId);
      const oldSession = this.#animatorSessions.get(entityId);
      const oldGraphDef = oldSession?.graphDefinition;
      const oldBlendSpace = oldSession?.blendSpace?.stopped === false
        ? {
            definition: oldSession.blendSpace.definition,
            input: oldSession.blendSpace.state().input,
            speed: oldSession.blendSpace.speed,
          }
        : undefined;
      const oldMorph = this.#morphControllers.get(entityId);

      // 1. Create new instance from newTemplate
      const newInstance = newTemplate.createInstance(entityId);

      // 2. Stop and detach old animator / mixer cleanly
      if (oldSession) {
        if (oldSession.outgoingAction) oldSession.outgoingAction.stop();
        if (oldSession.activeAction) oldSession.activeAction.stop();
        oldSession.blendSpace?.stop();
        oldSession.mixer.stopAllAction();
        if (oldModelScene) {
          oldSession.mixer.uncacheRoot(oldModelScene);
        }
        const oldClips = this.#clips.get(entityId);
        if (oldClips) {
          for (const clip of oldClips) {
            oldSession.mixer.uncacheClip(clip);
          }
        }
      }
      this.#animatorSessions.delete(entityId);
      this.#mixers.delete(entityId);
      this.#clips.delete(entityId);
      this.#activeActions.delete(entityId);

      // 3. Remove old modelScene from entity Object3D
      if (oldModelScene) {
        object.remove(oldModelScene);
        this.#modelScenes.delete(entityId);
      }

      // 4. Release old instance (refcount decrements, disposes old template if refCount reaches 0)
      if (oldInstance) {
        oldInstance.dispose();
      }

      // 5. Attach new instance
      this.#instances.set(entityId, newInstance);
      this.#attachInstance(entityId, object, newInstance, metadata);

      // 5b. Carry runtime morph overrides onto the new instance; targets the new
      // asset no longer has are dropped (and reported) rather than failing the reload.
      if (oldMorph && oldMorph.overrideCount > 0) {
        const newMorph = this.#morphControllers.get(entityId);
        const dropped = newMorph ? newMorph.adoptOverrides(oldMorph) : oldMorph.overriddenNames();
        this.#refreshMorphMetadata(entityId);
        if (dropped.length > 0) droppedMorphOverrides[entityId] = dropped;
      }

      // 6. If entity had an animation graph before, re-initialize it cleanly with the new clips/mixer
      if (oldGraphDef) {
        this.initAnimationGraph(entityId, oldGraphDef);
      }
      // 7. Restore an active blend space against the reloaded clips (best effort:
      // a clip removed by the reimport surfaces as a structured failure in metadata).
      if (oldBlendSpace) {
        const restored = this.playBlendSpace(entityId, oldBlendSpace.definition, {
          input: oldBlendSpace.input,
          speed: oldBlendSpace.speed,
        });
        if (!restored.success && metadata.animation) {
          metadata.animation.blendSpace = undefined;
        }
      }
    }

    this.#updateResourceSharingMetadata();
    return {
      success: true,
      affectedEntities,
      ...(Object.keys(droppedMorphOverrides).length > 0 ? { droppedMorphOverrides } : {}),
    };
  }

  #updateResourceSharingMetadata(): void {
    for (const [entityId, instance] of this.#instances) {
      const metadata = this.#models.get(entityId);
      if (metadata && metadata.instance) {
        metadata.resourceSharing = {
          templateRefCount: instance.template.refCount,
        };
      }
    }
  }


  registerAnimationClip(entityId: string, clip: THREE.AnimationClip): boolean {
    if (this.#disposed) return false;
    let clips = this.#clips.get(entityId);
    if (!clips) {
      clips = [];
      this.#clips.set(entityId, clips);
    }

    const existingIndex = clips.findIndex((c) => c.name === clip.name);
    if (existingIndex !== -1) {
      clips[existingIndex] = clip;
    } else {
      clips.push(clip);
    }

    const modelScene = this.#modelScenes.get(entityId);
    let mixer = this.#mixers.get(entityId);
    if (!mixer && modelScene) {
      mixer = new THREE.AnimationMixer(modelScene);
      this.#mixers.set(entityId, mixer);
      this.#animatorSessions.set(entityId, {
        entityId,
        mixer,
      });
    } else if (mixer && !this.#animatorSessions.has(entityId)) {
      this.#animatorSessions.set(entityId, {
        entityId,
        mixer,
      });
    }

    const metadata = this.#models.get(entityId);
    if (metadata) {
      if (!metadata.animation) {
        metadata.animation = {
          clips: clips.map((c) => ({ name: c.name, duration: c.duration })),
          playing: false,
          time: 0,
        };
      } else {
        metadata.animation.clips = clips.map((c) => ({
          name: c.name,
          duration: c.duration,
        }));
      }
    }

    return true;
  }

  /**
   * Sets runtime morph-target weights by semantic target name. All-or-nothing:
   * any unknown target or invalid weight rejects the whole request. A name
   * shared by several meshes drives all of them. Overrides persist across
   * animation playback and asset reloads until cleared.
   */
  setMorphWeights(entityId: string, weights: unknown): MorphSetResult {
    const resolved = this.#resolveMorphController(entityId);
    if ("error" in resolved) return resolved.error;
    const result = resolved.controller.setWeights(weights);
    if (result.success) this.#refreshMorphMetadata(entityId);
    return result;
  }

  /** Clears overrides for `names` (or every override) and restores authored defaults. */
  clearMorphWeights(entityId: string, names?: unknown): MorphClearResult {
    const resolved = this.#resolveMorphController(entityId);
    if ("error" in resolved) return resolved.error;
    const result = resolved.controller.clear(names);
    if (result.success) this.#refreshMorphMetadata(entityId);
    return result;
  }

  getMorphTargetController(entityId: string): MorphTargetController | undefined {
    return this.#morphControllers.get(entityId);
  }

  #resolveMorphController(
    entityId: string,
  ): { controller: MorphTargetController } | { error: MorphSetResult } {
    const fail = (code: string, message: string, remediation: string) => ({
      error: { success: false, error: `[${code}] ${message}`, diagnostics: [{ code, message, remediation }] },
    });
    if (this.#disposed) {
      return fail("anim.morph.runtimeDisposed", "Runtime is disposed", "Start the runtime again.");
    }
    const metadata = this.#models.get(entityId);
    if (!metadata || !metadata.loaded) {
      return fail(
        "anim.morph.noModel",
        `Entity "${entityId}" has no loaded model`,
        "Attach a Model component with a loaded glTF asset before setting morph weights.",
      );
    }
    const controller = this.#morphControllers.get(entityId);
    if (!controller) {
      return fail(
        "anim.morph.noTargets",
        `Model "${metadata.assetId}" on entity "${entityId}" has no morph targets`,
        "Export blend shapes (shape keys) with the glTF asset, or target a different entity.",
      );
    }
    return { controller };
  }

  #refreshMorphMetadata(entityId: string): void {
    const metadata = this.#models.get(entityId);
    const controller = this.#morphControllers.get(entityId);
    if (metadata && controller) metadata.morphTargets = controller.observe();
  }

  getAnimatorSession(entityId: string): EntityAnimatorSession | undefined {
    return this.#animatorSessions.get(entityId);
  }

  initAnimationGraph(
    entityId: string,
    graph: AnimationGraphDefinition,
  ): { success: boolean; diagnostics?: AnimationGraphDiagnostic[]; error?: string } {
    if (this.#disposed) {
      return { success: false, error: "Runtime is disposed" };
    }
    const metadata = this.#models.get(entityId);
    if (!metadata || !metadata.loaded) {
      return { success: false, error: `Entity "${entityId}" has no loaded model` };
    }

    const diagnostics = validateAnimationGraph(graph);
    if (diagnostics.length > 0) {
      return {
        success: false,
        diagnostics,
        error: `Invalid animation graph: ${diagnostics.map((d) => d.message).join("; ")}`,
      };
    }

    const clips = this.#clips.get(entityId) ?? [];
    const missingClips = graph.states.filter(
      (s) =>
        !clips.some(
          (c) =>
            c.name === s.clipId ||
            (!s.clipId.endsWith("_retargeted") && c.name === `${s.clipId}_retargeted`),
        ),
    );
    if (missingClips.length > 0) {
      const missingNames = missingClips
        .map((s) => `"${s.clipId}" (state "${s.id}")`)
        .join(", ");
      const diag: AnimationGraphDiagnostic = {
        code: "anim.state.clip.unknown",
        message: `Graph states reference unknown clip(s): ${missingNames}`,
      };
      return {
        success: false,
        diagnostics: [diag],
        error: diag.message,
      };
    }

    let session = this.#animatorSessions.get(entityId);
    if (!session) {
      const mixer = this.#mixers.get(entityId);
      if (!mixer) {
        return { success: false, error: `Entity "${entityId}" has no animation mixer` };
      }
      session = { entityId, mixer };
      this.#animatorSessions.set(entityId, session);
    }

    const machine = new AnimationGraphMachine(graph);
    session.graphMachine = machine;
    session.graphDefinition = graph;
    session.previousGraphState = undefined;
    session.lastTransitionId = undefined;

    // Start entry state with zero blend
    const entryDef = machine.currentStateDefinition;
    if (entryDef) {
      this.crossfadeAnimation(entityId, entryDef.clipId, 0, {
        loop: entryDef.loop !== false,
        speed: entryDef.speed,
        toState: machine.state,
      });
    }

    if (metadata.animation) {
      metadata.animation.graph = {
        state: machine.state,
        transitioning: false,
        blendProgress: 1.0,
      };
      metadata.animation.actions = [
        {
          clip: entryDef ? entryDef.clipId : machine.state,
          weight: 1.0,
          role: "active",
        },
      ];
    }

    return { success: true };
  }

  setAnimationGraphParameter(
    entityId: string,
    name: string,
    value: boolean | number,
  ): { success: boolean; error?: string; transition?: AnimationTransitionResult } {
    if (this.#disposed) return { success: false, error: "Runtime is disposed" };
    const session = this.#animatorSessions.get(entityId);
    if (!session || !session.graphMachine) {
      return { success: false, error: `Entity "${entityId}" has no active animation graph` };
    }

    try {
      session.graphMachine.set(name, value);
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    const transition = session.graphMachine.evaluate();
    if (transition) {
      this.#executeGraphTransition(session, transition);
      return { success: true, transition };
    }

    return { success: true };
  }

  triggerAnimationGraph(
    entityId: string,
    name: string,
  ): { success: boolean; error?: string; transition?: AnimationTransitionResult } {
    if (this.#disposed) return { success: false, error: "Runtime is disposed" };
    const session = this.#animatorSessions.get(entityId);
    if (!session || !session.graphMachine) {
      return { success: false, error: `Entity "${entityId}" has no active animation graph` };
    }

    try {
      session.graphMachine.trigger(name);
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    const transition = session.graphMachine.evaluate();
    if (transition) {
      this.#executeGraphTransition(session, transition);
      return { success: true, transition };
    }

    return { success: true };
  }

  evaluateAnimationGraph(entityId: string): { transition?: AnimationTransitionResult } {
    if (this.#disposed) return {};
    const session = this.#animatorSessions.get(entityId);
    if (!session || !session.graphMachine) return {};

    const transition = session.graphMachine.evaluate();
    if (transition) {
      this.#executeGraphTransition(session, transition);
      return { transition };
    }
    return {};
  }

  #executeGraphTransition(
    session: EntityAnimatorSession,
    transition: AnimationTransitionResult,
  ): boolean {
    const targetDef = session.graphMachine?.getStateDefinition(transition.to);
    if (!targetDef) return false;

    session.previousGraphState = transition.from;
    session.lastTransitionId = transition.transitionId;

    return this.crossfadeAnimation(session.entityId, targetDef.clipId, transition.blendSeconds, {
      loop: targetDef.loop !== false,
      speed: targetDef.speed,
      fromState: transition.from,
      toState: transition.to,
      transitionId: transition.transitionId,
    });
  }

  crossfadeAnimation(
    entityId: string,
    toClipName: string,
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
  ): boolean {
    if (this.#disposed) return false;
    const mixer = this.#mixers.get(entityId);
    const clips = this.#clips.get(entityId);
    const metadata = this.#models.get(entityId);
    if (!mixer || !clips || !metadata) {
      return false;
    }

    let clip = clips.find((c) => c.name === toClipName);
    let resolvedClipName = toClipName;
    if (!clip && !toClipName.endsWith("_retargeted")) {
      const retargeted = clips.find((c) => c.name === `${toClipName}_retargeted`);
      if (retargeted) {
        clip = retargeted;
        resolvedClipName = retargeted.name;
      }
    }
    if (!clip) {
      return false;
    }

    let session = this.#animatorSessions.get(entityId);
    if (!session) {
      session = { entityId, mixer };
      this.#animatorSessions.set(entityId, session);
    }

    // Direct clip playback (or a graph transition) takes over from a blend space.
    this.#stopBlendSpace(session, metadata);

    if (options.retargetSource !== undefined) {
      session.retargetSource = options.retargetSource;
    }
    if (options.retargetCacheKey !== undefined) {
      session.retargetCacheKey = options.retargetCacheKey;
    }

    if (session.rootMotion?.enabled) {
      const mode = session.rootMotion.mode;
      const rootBone = session.rootMotion.rootBoneName;
      const extractRes = extractRootMotionFromClip(clip, { mode, rootBoneName: rootBone });
      if (extractRes.success && extractRes.extracted) {
        clip = extractRes.extracted.inPlaceClip;
        session.rootMotion.sourceClipName = resolvedClipName;
        session.rootMotion.extracted = extractRes.extracted;
        session.rootMotion.playbackTime = 0;
      } else {
        session.rootMotion.sourceClipName = resolvedClipName;
        session.rootMotion.extracted = undefined;
        session.rootMotion.playbackTime = 0;
        session.rootMotion.lastRequestedDelta = [0, 0, 0];
        session.rootMotion.lastRequestedYaw = 0;
      }
      if (metadata.animation) {
        metadata.animation.rootMotion = {
          enabled: true,
          mode: session.rootMotion.mode,
          sourceClip: resolvedClipName,
          requestedDelta: [0, 0, 0],
          appliedDelta: [0, 0, 0],
          blockedDelta: [0, 0, 0],
          requestedYaw: 0,
          appliedYaw: 0,
          collisionClipped: false,
          accumulatedDistance: session.rootMotion.accumulatedDistance,
        };
      }
    }

    const shouldLoop = options.loop !== false;

    // Case 1: Immediate switch (blendSeconds <= 0)
    if (blendSeconds <= 0) {
      if (session.outgoingAction) {
        session.outgoingAction.stop();
        session.outgoingAction.setEffectiveWeight(0);
        session.outgoingAction = undefined;
        session.outgoingClipName = undefined;
      }
      if (session.activeAction) {
        session.activeAction.stop();
        session.activeAction.setEffectiveWeight(0);
      }

      const action = mixer.clipAction(clip);
      action.reset();
      action.setEffectiveWeight(1.0);
      action.enabled = true;
      if (shouldLoop) {
        action.loop = THREE.LoopRepeat;
        action.clampWhenFinished = false;
      } else {
        action.loop = THREE.LoopOnce;
        action.clampWhenFinished = true;
      }
      if (typeof options.speed === "number") {
        action.setEffectiveTimeScale(options.speed);
      } else {
        action.setEffectiveTimeScale(1.0);
      }
      action.play();

      session.activeAction = action;
      session.activeClipName = resolvedClipName;
      session.blend = undefined;
      this.#activeActions.set(entityId, action);

      if (!metadata.animation) {
        metadata.animation = {
          clips: clips.map((c) => ({ name: c.name, duration: c.duration })),
          activeClip: resolvedClipName,
          playing: true,
          time: 0,
          duration: clip.duration,
          ...(session.retargetSource !== undefined
            ? { retargetSource: session.retargetSource }
            : {}),
          ...(session.retargetCacheKey !== undefined
            ? { retargetCacheKey: session.retargetCacheKey }
            : {}),
        };
      } else {
        metadata.animation.activeClip = resolvedClipName;
        metadata.animation.playing = true;
        metadata.animation.time = 0;
        metadata.animation.duration = clip.duration;
        if (session.retargetSource !== undefined) {
          metadata.animation.retargetSource = session.retargetSource;
        }
        if (session.retargetCacheKey !== undefined) {
          metadata.animation.retargetCacheKey = session.retargetCacheKey;
        }
      }

      if (options.toState || session.graphMachine) {
        metadata.animation.graph = {
          state: options.toState ?? session.graphMachine?.state ?? resolvedClipName,
          ...(options.fromState ? { previousState: options.fromState } : {}),
          ...(options.transitionId ? { transitionId: options.transitionId } : {}),
          transitioning: false,
          blendProgress: 1.0,
        };
      }

      metadata.animation.actions = [
        { clip: resolvedClipName, weight: 1.0, role: "active" },
      ];

      return true;
    }

    // Case 2: Crossfade (blendSeconds > 0)
    let fromInitialWeight = 1.0;
    if (session.blend) {
      // Interruption: clean the superseded outgoing action
      if (session.outgoingAction) {
        session.outgoingAction.stop();
        session.outgoingAction.setEffectiveWeight(0);
      }
      session.outgoingAction = session.activeAction;
      session.outgoingClipName = session.activeClipName;
      fromInitialWeight = session.activeAction ? session.activeAction.getEffectiveWeight() : 1.0;
    } else {
      session.outgoingAction = session.activeAction;
      session.outgoingClipName = session.activeClipName;
      fromInitialWeight = session.activeAction ? session.activeAction.getEffectiveWeight() : 1.0;
      if (session.outgoingAction) {
        session.outgoingAction.setEffectiveWeight(fromInitialWeight);
      }
    }

    const nextAction = mixer.clipAction(clip);
    nextAction.reset();
    nextAction.setEffectiveWeight(0.0);
    nextAction.enabled = true;
    if (shouldLoop) {
      nextAction.loop = THREE.LoopRepeat;
      nextAction.clampWhenFinished = false;
    } else {
      nextAction.loop = THREE.LoopOnce;
      nextAction.clampWhenFinished = true;
    }
    if (typeof options.speed === "number") {
      nextAction.setEffectiveTimeScale(options.speed);
    } else {
      nextAction.setEffectiveTimeScale(1.0);
    }
    nextAction.play();

    session.activeAction = nextAction;
    session.activeClipName = resolvedClipName;
    this.#activeActions.set(entityId, nextAction);

    session.blend = {
      fromClip: session.outgoingClipName ?? "",
      toClip: resolvedClipName,
      fromState: options.fromState,
      toState: options.toState,
      transitionId: options.transitionId,
      blendSeconds,
      blendElapsed: 0,
      fromInitialWeight,
    };

    if (!metadata.animation) {
      metadata.animation = {
        clips: clips.map((c) => ({ name: c.name, duration: c.duration })),
        activeClip: resolvedClipName,
        playing: true,
        time: 0,
        duration: clip.duration,
        ...(session.retargetSource !== undefined
          ? { retargetSource: session.retargetSource }
          : {}),
        ...(session.retargetCacheKey !== undefined
          ? { retargetCacheKey: session.retargetCacheKey }
          : {}),
      };
    } else {
      metadata.animation.activeClip = resolvedClipName;
      metadata.animation.playing = true;
      metadata.animation.time = 0;
      metadata.animation.duration = clip.duration;
      if (session.retargetSource !== undefined) {
        metadata.animation.retargetSource = session.retargetSource;
      }
      if (session.retargetCacheKey !== undefined) {
        metadata.animation.retargetCacheKey = session.retargetCacheKey;
      }
    }

    metadata.animation.graph = {
      state: options.toState ?? session.graphMachine?.state ?? resolvedClipName,
      previousState: options.fromState ?? session.previousGraphState,
      transitionId: options.transitionId ?? session.lastTransitionId,
      transitioning: true,
      blendSeconds,
      blendElapsed: 0,
      blendProgress: 0,
    };

    metadata.animation.actions = [
      ...(session.outgoingClipName
        ? [{ clip: session.outgoingClipName, weight: fromInitialWeight, role: "outgoing" as const }]
        : []),
      { clip: resolvedClipName, weight: 0.0, role: "incoming" as const },
    ];

    return true;
  }

  /**
   * Play a locomotion blend space on an entity: every sample clip runs in phase,
   * weighted by `evaluateBlendSpace`. Replaces any direct clip playback or
   * crossfade in progress. Validation happens before anything playing is
   * stopped, so a rejected request leaves the current animation untouched.
   */
  playBlendSpace(
    entityId: string,
    space: BlendSpaceDefinition,
    options: { input?: Readonly<Record<string, number>> | undefined; speed?: number | undefined } = {},
  ): BlendSpaceRuntimeResult {
    if (this.#disposed) {
      return { success: false, code: "runtime.disposed", error: "Runtime is disposed" };
    }
    const metadata = this.#models.get(entityId);
    const mixer = this.#mixers.get(entityId);
    const clips = this.#clips.get(entityId);
    if (!metadata || !metadata.loaded || !mixer || !clips) {
      return {
        success: false,
        code: "anim.blendSpace.entity.noModel",
        error: `Entity "${entityId}" has no loaded animated model`,
      };
    }

    let session = this.#animatorSessions.get(entityId);
    if (session?.rootMotion?.enabled) {
      return {
        success: false,
        code: "anim.blendSpace.rootMotionUnsupported",
        error: `Entity "${entityId}" has root motion enabled; blend-space root motion is not supported yet`,
      };
    }

    const created = BlendSpacePlayback.create(space, mixer, clips, options);
    if (!created.success) {
      return {
        success: false,
        code: created.code,
        error: created.error,
        ...(created.diagnostics ? { diagnostics: created.diagnostics } : {}),
      };
    }

    if (!session) {
      session = { entityId, mixer };
      this.#animatorSessions.set(entityId, session);
    }

    // Stop whatever was playing: previous blend space, crossfade, single clip.
    this.#stopBlendSpace(session, metadata);
    if (session.outgoingAction) {
      session.outgoingAction.stop();
      session.outgoingAction.setEffectiveWeight(0);
    }
    if (session.activeAction) {
      session.activeAction.stop();
      session.activeAction.setEffectiveWeight(0);
    }
    session.outgoingAction = undefined;
    session.outgoingClipName = undefined;
    session.activeAction = undefined;
    session.activeClipName = undefined;
    session.blend = undefined;
    this.#activeActions.delete(entityId);

    const playback = created.playback;
    playback.begin();
    session.blendSpace = playback;

    if (!metadata.animation) {
      metadata.animation = {
        clips: clips.map((c) => ({ name: c.name, duration: c.duration })),
        playing: true,
        time: 0,
      };
    }
    delete metadata.animation.graph;
    this.#publishBlendSpaceState(playback, metadata);

    return { success: true, state: playback.state() };
  }

  /** Update one or both blend-space axes. Atomic on failure. */
  setBlendSpaceInput(
    entityId: string,
    input: Readonly<Record<string, number>>,
  ): BlendSpaceRuntimeResult {
    if (this.#disposed) {
      return { success: false, code: "runtime.disposed", error: "Runtime is disposed" };
    }
    const session = this.#animatorSessions.get(entityId);
    const playback = session?.blendSpace;
    if (!playback || playback.stopped) {
      return {
        success: false,
        code: "anim.blendSpace.notPlaying",
        error: `Entity "${entityId}" is not playing a blend space`,
      };
    }
    const result = playback.setInput(input);
    if (!result.success) {
      return { success: false, code: result.code, error: result.error };
    }
    const metadata = this.#models.get(entityId);
    if (metadata?.animation) this.#publishBlendSpaceState(playback, metadata);
    return { success: true, state: result.state };
  }

  getBlendSpaceState(entityId: string): BlendSpacePlaybackState | undefined {
    const playback = this.#animatorSessions.get(entityId)?.blendSpace;
    return playback && !playback.stopped ? playback.state() : undefined;
  }

  #stopBlendSpace(session: EntityAnimatorSession, metadata: ModelMetadata | undefined): void {
    if (!session.blendSpace) return;
    session.blendSpace.stop();
    session.blendSpace = undefined;
    if (metadata?.animation) {
      delete metadata.animation.blendSpace;
      delete metadata.animation.actions;
    }
  }

  #publishBlendSpaceState(playback: BlendSpacePlayback, metadata: ModelMetadata): void {
    if (!metadata.animation) return;
    const state = playback.state();
    const dominant = playback.getAction(state.dominantClip);
    metadata.animation.blendSpace = state;
    metadata.animation.activeClip = state.dominantClip;
    metadata.animation.playing = true;
    metadata.animation.time = dominant ? dominant.time : 0;
    metadata.animation.duration = dominant ? dominant.getClip().duration : undefined;
    metadata.animation.actions = state.weights.map((w) => ({
      clip: w.clip,
      weight: w.weight,
      role: "blend" as const,
    }));
  }

  playAnimation(
    entityId: string,
    clipName: string,
    options: {
      loop?: boolean | undefined;
      retargetSource?: string | undefined;
      retargetCacheKey?: string | undefined;
    } = {},
  ): boolean {
    return this.crossfadeAnimation(entityId, clipName, 0, options);
  }

  stopAnimation(entityId: string): void {
    const session = this.#animatorSessions.get(entityId);
    if (session) {
      if (session.outgoingAction) {
        session.outgoingAction.stop();
        session.outgoingAction.setEffectiveWeight(0);
        session.outgoingAction = undefined;
        session.outgoingClipName = undefined;
      }
      if (session.activeAction) {
        session.activeAction.stop();
        session.activeAction.setEffectiveWeight(0);
        session.activeAction = undefined;
        session.activeClipName = undefined;
      }
      session.blend = undefined;
      this.#stopBlendSpace(session, this.#models.get(entityId));
      if (session.graphMachine) {
        session.graphMachine.reset();
      }
      session.previousGraphState = undefined;
      session.lastTransitionId = undefined;
      if (session.rootMotion) {
        session.rootMotion.accumulatedDistance = 0;
        session.rootMotion.playbackTime = 0;
        session.rootMotion.lastRequestedDelta = [0, 0, 0];
        session.rootMotion.lastAppliedDelta = [0, 0, 0];
        session.rootMotion.lastBlockedDelta = [0, 0, 0];
      }
    }

    const action = this.#activeActions.get(entityId);
    if (action) {
      action.stop();
      this.#activeActions.delete(entityId);
    }
    const mixer = this.#mixers.get(entityId);
    if (mixer) {
      mixer.stopAllAction();
    }
    const metadata = this.#models.get(entityId);
    if (metadata?.animation) {
      metadata.animation.playing = false;
      metadata.animation.time = 0;
      delete metadata.animation.activeClip;
      delete metadata.animation.duration;
      delete metadata.animation.retargetSource;
      delete metadata.animation.retargetCacheKey;
      delete metadata.animation.graph;
      delete metadata.animation.actions;
      delete metadata.animation.rootMotion;
    }
    const modelScene = this.#modelScenes.get(entityId);
    if (metadata && modelScene) {
      metadata.nodes = this.#extractNodeStates(modelScene);
    }
  }

  configureRootMotion(
    entityId: string,
    options: {
      enabled: boolean;
      mode?: RootMotionMode | undefined;
      rootBoneName?: string | undefined;
    },
  ): { success: boolean; diagnostics?: RootMotionDiagnostics; error?: string } {
    if (this.#disposed) {
      return { success: false, error: "Runtime is disposed" };
    }
    const metadata = this.#models.get(entityId);
    if (!metadata || !metadata.loaded) {
      return { success: false, error: `Entity "${entityId}" has no loaded model` };
    }

    let session = this.#animatorSessions.get(entityId);
    if (!session) {
      const mixer = this.#mixers.get(entityId);
      if (!mixer) {
        return { success: false, error: `Entity "${entityId}" has no animation mixer` };
      }
      session = { entityId, mixer };
      this.#animatorSessions.set(entityId, session);
    }

    if (!options.enabled) {
      if (session.rootMotion) {
        session.rootMotion.enabled = false;
      }
      if (metadata.animation?.rootMotion) {
        metadata.animation.rootMotion.enabled = false;
      }
      return { success: true };
    }

    const rootBoneName = options.rootBoneName ?? "Hips";
    const modelScene = this.#modelScenes.get(entityId);
    let boneFound = false;
    if (modelScene) {
      modelScene.traverse((obj) => {
        if (obj.name === rootBoneName) {
          boneFound = true;
        }
      });
    }

    if (!boneFound) {
      const diag: RootMotionDiagnostics = {
        code: "animation.rootMotion.invalidRoot",
        message: `Root bone "${rootBoneName}" not found in model for entity "${entityId}"`,
        hint: `Ensure rootBoneName matches an existing skeleton node (e.g. 'Hips' or 'root')`,
      };
      return { success: false, diagnostics: diag, error: diag.message };
    }

    const mode = options.mode ?? "extract-xz";

    // If there is an active clip, extract and swap in the inPlaceClip
    let extracted: ExtractedClipRootMotion | undefined;
    if (session.activeClipName && mode !== "none") {
      const clips = this.#clips.get(entityId) ?? [];
      const originalClip = clips.find(
        (c) => c.name === session!.activeClipName || `${c.name}_retargeted` === session!.activeClipName,
      );
      if (originalClip) {
        const extractRes = extractRootMotionFromClip(originalClip, {
          mode,
          rootBoneName,
        });
        if (!extractRes.success) {
          return {
            success: false,
            ...(extractRes.diagnostics ? { diagnostics: extractRes.diagnostics } : {}),
            ...(extractRes.error ? { error: extractRes.error } : {}),
          };
        }
        extracted = extractRes.extracted;
        if (extracted && session.activeAction) {
          const curTime = session.activeAction.time;
          const curWeight = session.activeAction.getEffectiveWeight();
          const curScale = session.activeAction.getEffectiveTimeScale();
          session.activeAction.stop();

          const inPlaceAction = session.mixer.clipAction(extracted.inPlaceClip);
          inPlaceAction.time = curTime;
          inPlaceAction.setEffectiveWeight(curWeight);
          inPlaceAction.setEffectiveTimeScale(curScale);
          inPlaceAction.play();
          session.activeAction = inPlaceAction;
          this.#activeActions.set(entityId, inPlaceAction);
        }
      }
    }

    session.rootMotion = {
      enabled: true,
      mode,
      rootBoneName,
      sourceClipName: session.activeClipName,
      extracted,
      playbackTime: session.activeAction?.time ?? 0,
      accumulatedDistance: 0,
      lastRequestedDelta: [0, 0, 0],
      lastAppliedDelta: [0, 0, 0],
      lastBlockedDelta: [0, 0, 0],
      lastRequestedYaw: 0,
      lastAppliedYaw: 0,
      lastCollisionClipped: false,
    };

    if (metadata.animation) {
      metadata.animation.rootMotion = {
        enabled: true,
        mode,
        sourceClip: session.activeClipName,
        requestedDelta: [0, 0, 0],
        appliedDelta: [0, 0, 0],
        blockedDelta: [0, 0, 0],
        requestedYaw: 0,
        appliedYaw: 0,
        collisionClipped: false,
        accumulatedDistance: 0,
      };
    }

    return { success: true };
  }

  sampleRootMotion(entityId: string, deltaSeconds: number): RootMotionFrameDelta {
    if (this.#disposed || deltaSeconds <= 0) {
      return { translation: [0, 0, 0], yaw: 0 };
    }
    const session = this.#animatorSessions.get(entityId);
    if (!session || !session.rootMotion || !session.rootMotion.enabled) {
      return { translation: [0, 0, 0], yaw: 0 };
    }

    const rm = session.rootMotion;
    if (!rm.extracted) {
      rm.lastRequestedDelta = [0, 0, 0];
      rm.lastRequestedYaw = 0;
      return { translation: [0, 0, 0], yaw: 0 };
    }

    const action = session.activeAction;
    const speed = action ? action.getEffectiveTimeScale() : 1.0;
    const isLooping = action ? action.loop === THREE.LoopRepeat : true;

    const frameDelta = computeRootMotionStepDelta(
      rm.extracted.samples,
      rm.extracted.duration,
      rm.playbackTime,
      deltaSeconds,
      rm.mode,
      { isLooping, speed },
    );

    rm.playbackTime += deltaSeconds * speed;
    if (isLooping) {
      rm.playbackTime =
        ((rm.playbackTime % rm.extracted.duration) + rm.extracted.duration) %
        rm.extracted.duration;
    } else {
      rm.playbackTime = Math.min(rm.extracted.duration, rm.playbackTime);
    }

    rm.lastRequestedDelta = frameDelta.translation;
    rm.lastRequestedYaw = frameDelta.yaw;

    return frameDelta;
  }

  recordRootMotionResult(
    entityId: string,
    result: {
      requestedDelta: [number, number, number];
      appliedDelta: [number, number, number];
      blockedDelta: [number, number, number];
      requestedYaw: number;
      appliedYaw: number;
      collisionClipped: boolean;
    },
  ): void {
    const session = this.#animatorSessions.get(entityId);
    const metadata = this.#models.get(entityId);
    if (session?.rootMotion) {
      session.rootMotion.lastRequestedDelta = result.requestedDelta;
      session.rootMotion.lastAppliedDelta = result.appliedDelta;
      session.rootMotion.lastBlockedDelta = result.blockedDelta;
      session.rootMotion.lastRequestedYaw = result.requestedYaw;
      session.rootMotion.lastAppliedYaw = result.appliedYaw;
      session.rootMotion.lastCollisionClipped = result.collisionClipped;
      session.rootMotion.accumulatedDistance += Math.hypot(
        result.appliedDelta[0],
        result.appliedDelta[2],
      );
    }
    if (metadata?.animation) {
      metadata.animation.rootMotion = {
        enabled: session?.rootMotion?.enabled ?? false,
        mode: session?.rootMotion?.mode ?? "extract-xz",
        sourceClip: session?.rootMotion?.sourceClipName,
        requestedDelta: result.requestedDelta,
        appliedDelta: result.appliedDelta,
        blockedDelta: result.blockedDelta,
        requestedYaw: result.requestedYaw,
        appliedYaw: result.appliedYaw,
        collisionClipped: result.collisionClipped,
        accumulatedDistance: session?.rootMotion?.accumulatedDistance ?? 0,
      };
    }
  }

  updateAnimation(deltaSeconds: number): void {
    if (this.#disposed || deltaSeconds <= 0) return;

    for (const [entityId, session] of this.#animatorSessions) {
      const metadata = this.#models.get(entityId);

      if (session.blend) {
        session.blend.blendElapsed += deltaSeconds;
        const progress =
          session.blend.blendSeconds > 0
            ? Math.min(1.0, session.blend.blendElapsed / session.blend.blendSeconds)
            : 1.0;

        if (progress < 1.0) {
          const outWeight = session.blend.fromInitialWeight * (1.0 - progress);
          const inWeight = progress;
          if (session.outgoingAction) {
            session.outgoingAction.setEffectiveWeight(outWeight);
          }
          if (session.activeAction) {
            session.activeAction.setEffectiveWeight(inWeight);
          }

          if (metadata?.animation) {
            metadata.animation.graph = {
              state: session.graphMachine?.state ?? session.blend.toState ?? session.blend.toClip,
              previousState: session.blend.fromState ?? session.previousGraphState,
              transitionId: session.blend.transitionId,
              transitioning: true,
              blendSeconds: session.blend.blendSeconds,
              blendElapsed: session.blend.blendElapsed,
              blendProgress: progress,
            };
            metadata.animation.actions = [
              ...(session.outgoingAction && session.outgoingClipName
                ? [{ clip: session.outgoingClipName, weight: outWeight, role: "outgoing" as const }]
                : []),
              ...(session.activeAction && session.activeClipName
                ? [{ clip: session.activeClipName, weight: inWeight, role: "incoming" as const }]
                : []),
            ];
          }
        } else {
          // Blend complete!
          if (session.outgoingAction) {
            session.outgoingAction.setEffectiveWeight(0);
            session.outgoingAction.stop();
            session.outgoingAction = undefined;
            session.outgoingClipName = undefined;
          }
          if (session.activeAction) {
            session.activeAction.setEffectiveWeight(1.0);
          }

          const finishedState =
            session.graphMachine?.state ?? session.blend.toState ?? session.activeClipName ?? "";
          const prev = session.blend.fromState ?? session.previousGraphState;
          const transId = session.blend.transitionId;
          session.blend = undefined;

          if (metadata?.animation) {
            metadata.animation.graph = {
              state: finishedState,
              ...(prev ? { previousState: prev } : {}),
              ...(transId ? { transitionId: transId } : {}),
              transitioning: false,
              blendProgress: 1.0,
            };
            metadata.animation.actions = [
              ...(session.activeAction && session.activeClipName
                ? [{ clip: session.activeClipName, weight: 1.0, role: "active" as const }]
                : []),
            ];
          }
        }
      } else if (metadata?.animation && session.activeAction && session.activeClipName) {
        if (!metadata.animation.actions || metadata.animation.actions.length === 0) {
          metadata.animation.actions = [
            { clip: session.activeClipName, weight: 1.0, role: "active" as const },
          ];
        }
      }

      session.blendSpace?.prepareStep(deltaSeconds);
      session.mixer.update(deltaSeconds);
      if (session.blendSpace && metadata?.animation) {
        this.#publishBlendSpaceState(session.blendSpace, metadata);
      }

      const morph = this.#morphControllers.get(entityId);
      if (morph) {
        // Runtime overrides win over clip tracks animating the same targets.
        morph.applyOverrides();
        if (metadata) metadata.morphTargets = morph.observe();
      }

      const modelScene = this.#modelScenes.get(entityId);
      if (metadata && modelScene) {
        metadata.nodes = this.#extractNodeStates(modelScene);

        const box = new THREE.Box3().setFromObject(modelScene);
        const size = new THREE.Vector3();
        box.getSize(size);
        metadata.bounds = {
          min: [box.min.x, box.min.y, box.min.z],
          max: [box.max.x, box.max.y, box.max.z],
          size: [size.x, size.y, size.z],
        };

        if (metadata.animation && session.activeAction) {
          metadata.animation.time = session.activeAction.time;
          metadata.animation.playing = session.activeAction.isRunning();
        }
      }
    }
  }

  #extractNodeStates(modelScene: THREE.Group): ModelNodeState[] {
    const nodes: ModelNodeState[] = [];
    modelScene.traverse((child) => {
      if (child !== modelScene) {
        nodes.push({
          name: child.name,
          position: [child.position.x, child.position.y, child.position.z],
          rotation: [
            child.quaternion.x,
            child.quaternion.y,
            child.quaternion.z,
            child.quaternion.w,
          ],
          scale: [child.scale.x, child.scale.y, child.scale.z],
        });
      }
    });
    return nodes;
  }

  #attachInstance(
    entityId: string,
    object: THREE.Object3D,
    instance: ModelInstance,
    metadata: ModelMetadata,
  ): void {
    const modelScene = instance.scene;
    const animations = instance.animations;

    const box = new THREE.Box3().setFromObject(modelScene);
    const size = new THREE.Vector3();
    box.getSize(size);

    metadata.loaded = true;
    metadata.meshCount = instance.meshCount;
    metadata.nodeCount = instance.nodeCount;
    metadata.skinnedMeshCount = instance.skinnedMeshCount;
    metadata.hasSkin = instance.skinnedMeshCount > 0;
    metadata.bounds = {
      min: [box.min.x, box.min.y, box.min.z],
      max: [box.max.x, box.max.y, box.max.z],
      size: [size.x, size.y, size.z],
    };
    metadata.nodes = this.#extractNodeStates(modelScene);
    metadata.instance = {
      assetId: instance.assetId,
      instanceId: instance.instanceId,
      sharedTemplateId: instance.templateId,
      skinnedMeshCount: instance.skinnedMeshCount,
      skeletonCount: instance.skeletonCount,
      fingerprint: instance.fingerprint,
      templateRevision: instance.revision,
    };
    metadata.resourceSharing = {
      templateRefCount: instance.template.refCount,
    };
    metadata.assetFingerprint = instance.fingerprint;
    metadata.templateRevision = instance.revision;

    if (animations.length > 0) {
      const mixer = new THREE.AnimationMixer(modelScene);
      this.#mixers.set(entityId, mixer);
      this.#clips.set(entityId, [...animations]);
      this.#animatorSessions.set(entityId, {
        entityId,
        mixer,
      });
      metadata.animation = {
        clips: animations.map((clip) => ({
          name: clip.name,
          duration: clip.duration,
        })),
        playing: false,
        time: 0,
      };
    }

    const morph = MorphTargetController.fromScene(modelScene);
    if (morph) {
      this.#morphControllers.set(entityId, morph);
      metadata.morphTargets = morph.observe();
    } else {
      this.#morphControllers.delete(entityId);
      delete metadata.morphTargets;
    }

    delete metadata.error;

    modelScene.name = `${object.name}:Model`;
    this.#modelScenes.set(entityId, modelScene);
    object.add(modelScene);
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }

    for (const session of this.#animatorSessions.values()) {
      if (session.outgoingAction) session.outgoingAction.stop();
      if (session.activeAction) session.activeAction.stop();
      session.blendSpace?.stop();
    }
    this.#animatorSessions.clear();

    for (const action of this.#activeActions.values()) {
      action.stop();
    }
    this.#activeActions.clear();

    for (const [entityId, mixer] of this.#mixers) {
      mixer.stopAllAction();
      const modelScene = this.#modelScenes.get(entityId);
      if (modelScene) {
        mixer.uncacheRoot(modelScene);
      }
      const clips = this.#clips.get(entityId);
      if (clips) {
        for (const clip of clips) {
          mixer.uncacheClip(clip);
        }
      }
    }
    this.#mixers.clear();
    this.#clips.clear();
    this.#modelScenes.clear();
    this.#morphControllers.clear();

    // Dispose all active instances (disposes cloned materials and skeletons, removes from parent, releases template refs)
    for (const instance of this.#instances.values()) {
      instance.dispose();
    }
    this.#instances.clear();

    // Dispose shared template cache (disposes shared geometries, shared textures, shared template materials)
    this.#templateCache.dispose();

    for (const object of this.#objects.values()) {
      disposeObjectResources(object);
      object.removeFromParent();
    }

    this.scene.clear();
    this.#objects.clear();
    this.#models.clear();
    this.#disposed = true;
  }
}

