import type {
  EntityDefinition,
  ProjectDocument,
  SceneDefinition,
} from "@kinetra/project-model";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

import type { AssetResolver, ModelMetadata, ModelNodeState } from "./assets.js";
import { asObject, numberValue, stringValue, vec3Value } from "./components.js";

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

  playAnimation(
    entityId: string,
    clipName: string,
    options: { loop?: boolean } = {},
  ): boolean {
    if (this.#disposed) return false;
    const mixer = this.#mixers.get(entityId);
    const clips = this.#clips.get(entityId);
    const metadata = this.#models.get(entityId);
    if (!mixer || !clips || !metadata) {
      return false;
    }

    const clip = clips.find((c) => c.name === clipName);
    if (!clip) {
      return false;
    }

    const existingAction = this.#activeActions.get(entityId);
    if (existingAction) {
      existingAction.stop();
    }

    const action = mixer.clipAction(clip);
    action.reset();
    const shouldLoop = options.loop !== false;
    if (shouldLoop) {
      action.loop = THREE.LoopRepeat;
      action.clampWhenFinished = false;
    } else {
      action.loop = THREE.LoopOnce;
      action.clampWhenFinished = true;
    }
    action.play();
    this.#activeActions.set(entityId, action);

    if (!metadata.animation) {
      metadata.animation = {
        clips: clips.map((c) => ({ name: c.name, duration: c.duration })),
        activeClip: clipName,
        playing: true,
        time: 0,
        duration: clip.duration,
      };
    } else {
      metadata.animation.activeClip = clipName;
      metadata.animation.playing = true;
      metadata.animation.time = 0;
      metadata.animation.duration = clip.duration;
    }

    return true;
  }

  stopAnimation(entityId: string): void {
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
    }
    const modelScene = this.#modelScenes.get(entityId);
    if (metadata && modelScene) {
      metadata.nodes = this.#extractNodeStates(modelScene);
    }
  }

  updateAnimation(deltaSeconds: number): void {
    if (this.#disposed || deltaSeconds <= 0) return;

    for (const [entityId, mixer] of this.#mixers) {
      mixer.update(deltaSeconds);

      const metadata = this.#models.get(entityId);
      const action = this.#activeActions.get(entityId);
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

        if (metadata.animation && action) {
          metadata.animation.time = action.time;
          metadata.animation.playing = action.isRunning();
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
