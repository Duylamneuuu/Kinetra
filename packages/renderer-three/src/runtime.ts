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
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

import type { AssetResolver, ModelMetadata, ModelNodeState } from "./assets.js";
import { asObject, numberValue, stringValue, vec3Value } from "./components.js";

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

export interface EntityAnimatorSession {
  entityId: string;
  mixer: THREE.AnimationMixer;
  activeAction?: THREE.AnimationAction | undefined;
  activeClipName?: string | undefined;
  outgoingAction?: THREE.AnimationAction | undefined;
  outgoingClipName?: string | undefined;
  blend?: AnimatorBlendSession | undefined;
  graphMachine?: AnimationGraphMachine | undefined;
  previousGraphState?: string | undefined;
  lastTransitionId?: string | undefined;
  retargetSource?: string | undefined;
  retargetCacheKey?: string | undefined;
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

  async loadModels(resolver: AssetResolver): Promise<Map<string, ModelMetadata>> {
    if (this.#disposed) {
      throw new Error("Cannot load models into a disposed ThreeSceneRuntime");
    }

    const loader = new GLTFLoader();

    for (const [entityId, metadata] of this.#models) {
      const object = this.#objects.get(entityId);
      if (!object) {
        continue;
      }

      try {
        const resolved = await resolver.resolve(metadata.assetId);
        if (!resolved) {
          metadata.loaded = false;
          metadata.error = `Asset "${metadata.assetId}" could not be resolved`;
          continue;
        }

        let arrayBuffer: ArrayBuffer;
        if (resolved instanceof Uint8Array) {
          const copy = new Uint8Array(resolved.byteLength);
          copy.set(resolved);
          arrayBuffer = copy.buffer;
        } else if (resolved instanceof ArrayBuffer) {
          arrayBuffer = resolved;
        } else if (typeof resolved === "string") {
          if (resolved.startsWith("data:")) {
            const base64Index = resolved.indexOf("base64,");
            if (base64Index !== -1) {
              const raw = atob(resolved.slice(base64Index + 7));
              const bytes = new Uint8Array(raw.length);
              for (let i = 0; i < raw.length; i++) {
                bytes[i] = raw.charCodeAt(i);
              }
              arrayBuffer = bytes.buffer;
            } else {
              const gltf = await loader.loadAsync(resolved);
              this.#attachModel(entityId, object, gltf.scene, gltf.animations ?? [], metadata);
              continue;
            }
          } else {
            const gltf = await loader.loadAsync(resolved);
            this.#attachModel(entityId, object, gltf.scene, gltf.animations ?? [], metadata);
            continue;
          }
        } else {
          metadata.loaded = false;
          metadata.error = `Unsupported asset resolution type for "${metadata.assetId}"`;
          continue;
        }

        const gltf = await loader.parseAsync(arrayBuffer, "");
        this.#attachModel(entityId, object, gltf.scene, gltf.animations ?? [], metadata);
      } catch (error) {
        metadata.loaded = false;
        metadata.error = error instanceof Error ? error.message : String(error);
      }
    }

    return this.#models;
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

    if (options.retargetSource !== undefined) {
      session.retargetSource = options.retargetSource;
    }
    if (options.retargetCacheKey !== undefined) {
      session.retargetCacheKey = options.retargetCacheKey;
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
      if (session.graphMachine) {
        session.graphMachine.reset();
      }
      session.previousGraphState = undefined;
      session.lastTransitionId = undefined;
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
    }
    const modelScene = this.#modelScenes.get(entityId);
    if (metadata && modelScene) {
      metadata.nodes = this.#extractNodeStates(modelScene);
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

      session.mixer.update(deltaSeconds);

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

  #attachModel(
    entityId: string,
    object: THREE.Object3D,
    modelScene: THREE.Group,
    animations: THREE.AnimationClip[],
    metadata: ModelMetadata,
  ): void {
    let meshCount = 0;
    let nodeCount = 0;
    let skinnedMeshCount = 0;

    modelScene.traverse((node) => {
      nodeCount++;
      if (node instanceof THREE.Mesh) {
        meshCount++;
        if (node instanceof THREE.SkinnedMesh) {
          skinnedMeshCount++;
        }
      }
    });

    const box = new THREE.Box3().setFromObject(modelScene);
    const size = new THREE.Vector3();
    box.getSize(size);

    metadata.loaded = true;
    metadata.meshCount = meshCount;
    metadata.nodeCount = nodeCount;
    metadata.skinnedMeshCount = skinnedMeshCount;
    metadata.hasSkin = skinnedMeshCount > 0;
    metadata.bounds = {
      min: [box.min.x, box.min.y, box.min.z],
      max: [box.max.x, box.max.y, box.max.z],
      size: [size.x, size.y, size.z],
    };
    metadata.nodes = this.#extractNodeStates(modelScene);

    if (animations.length > 0) {
      const mixer = new THREE.AnimationMixer(modelScene);
      this.#mixers.set(entityId, mixer);
      this.#clips.set(entityId, animations);
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
