import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as skeletonClone } from "three/examples/jsm/utils/SkeletonUtils.js";

import type { AssetResolver } from "./assets.js";

export class ModelAssetTemplate {
  readonly assetId: string;
  readonly templateId: string;
  readonly scene: THREE.Group;
  readonly animations: THREE.AnimationClip[];
  readonly sharedGeometries = new Set<THREE.BufferGeometry>();
  readonly sharedTextures = new Set<THREE.Texture>();
  readonly sharedMaterials = new Set<THREE.Material>();
  readonly fingerprint?: string | undefined;
  readonly revision: number;

  #refCount = 0;
  #instanceCounter = 0;
  #disposed = false;

  constructor(
    assetId: string,
    templateId: string,
    gltf: GLTF,
    options?: { fingerprint?: string | undefined; revision?: number | undefined },
  ) {
    this.assetId = assetId;
    this.templateId = templateId;
    this.scene = gltf.scene;
    this.animations = gltf.animations ?? [];
    this.fingerprint = options?.fingerprint;
    this.revision = options?.revision ?? 1;

    this.scene.traverse((node) => {
      if (node instanceof THREE.Mesh) {
        if (node.geometry) {
          this.sharedGeometries.add(node.geometry);
        }
        if (Array.isArray(node.material)) {
          for (const mat of node.material) {
            this.#catalogMaterial(mat);
          }
        } else if (node.material) {
          this.#catalogMaterial(node.material);
        }
      }
    });
  }

  #catalogMaterial(material: THREE.Material): void {
    this.sharedMaterials.add(material);
    for (const value of Object.values(material)) {
      if (value instanceof THREE.Texture) {
        this.sharedTextures.add(value);
      }
    }
  }

  get refCount(): number {
    return this.#refCount;
  }

  get isDisposed(): boolean {
    return this.#disposed;
  }

  createInstance(entityId: string): ModelInstance {
    if (this.#disposed) {
      throw new Error(
        `[model.instance.resourceReleased] Cannot instantiate from disposed template "${this.templateId}" for asset "${this.assetId}"`,
      );
    }

    this.#instanceCounter++;
    const instanceId = `inst_${entityId}_${this.#instanceCounter}`;

    let clonedScene: THREE.Group;
    try {
      clonedScene = skeletonClone(this.scene) as THREE.Group;
    } catch (err) {
      throw new Error(
        `[model.instance.cloneFailed] Failed to clone skeleton for entity "${entityId}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const instanceMaterials = new Set<THREE.Material>();
    const instanceSkeletons = new Set<THREE.Skeleton>();
    let skinnedMeshCount = 0;
    let meshCount = 0;
    let nodeCount = 0;

    clonedScene.traverse((node) => {
      nodeCount++;
      if (node instanceof THREE.Mesh) {
        meshCount++;
        if (Array.isArray(node.material)) {
          node.material = node.material.map((mat) => {
            const clonedMat = mat.clone();
            instanceMaterials.add(clonedMat);
            return clonedMat;
          });
        } else if (node.material) {
          const clonedMat = node.material.clone();
          instanceMaterials.add(clonedMat);
          node.material = clonedMat;
        }

        if (node instanceof THREE.SkinnedMesh) {
          skinnedMeshCount++;
          if (node.skeleton) {
            instanceSkeletons.add(node.skeleton);
          }
        }
      }
    });

    this.#refCount++;

    return new ModelInstance({
      assetId: this.assetId,
      templateId: this.templateId,
      instanceId,
      entityId,
      scene: clonedScene,
      animations: this.animations,
      materials: instanceMaterials,
      skeletons: instanceSkeletons,
      meshCount,
      nodeCount,
      skinnedMeshCount,
      skeletonCount: instanceSkeletons.size,
      template: this,
      fingerprint: this.fingerprint,
      revision: this.revision,
    });
  }

  releaseInstance(instance: ModelInstance): void {
    if (this.#refCount > 0) {
      this.#refCount--;
    }
    if (this.#refCount === 0) {
      this.dispose();
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;

    for (const geom of this.sharedGeometries) {
      geom.dispose();
    }
    this.sharedGeometries.clear();

    for (const tex of this.sharedTextures) {
      tex.dispose();
    }
    this.sharedTextures.clear();

    for (const mat of this.sharedMaterials) {
      mat.dispose();
    }
    this.sharedMaterials.clear();
  }
}

export class ModelInstance {
  readonly assetId: string;
  readonly templateId: string;
  readonly instanceId: string;
  readonly entityId: string;
  readonly scene: THREE.Group;
  readonly animations: THREE.AnimationClip[];
  readonly materials: Set<THREE.Material>;
  readonly skeletons: Set<THREE.Skeleton>;
  readonly meshCount: number;
  readonly nodeCount: number;
  readonly skinnedMeshCount: number;
  readonly skeletonCount: number;
  readonly template: ModelAssetTemplate;
  readonly fingerprint?: string | undefined;
  readonly revision: number;
  #disposed = false;

  constructor(init: {
    assetId: string;
    templateId: string;
    instanceId: string;
    entityId: string;
    scene: THREE.Group;
    animations: THREE.AnimationClip[];
    materials: Set<THREE.Material>;
    skeletons: Set<THREE.Skeleton>;
    meshCount: number;
    nodeCount: number;
    skinnedMeshCount: number;
    skeletonCount: number;
    template: ModelAssetTemplate;
    fingerprint?: string | undefined;
    revision?: number | undefined;
  }) {
    this.assetId = init.assetId;
    this.templateId = init.templateId;
    this.instanceId = init.instanceId;
    this.entityId = init.entityId;
    this.scene = init.scene;
    this.animations = init.animations;
    this.materials = init.materials;
    this.skeletons = init.skeletons;
    this.meshCount = init.meshCount;
    this.nodeCount = init.nodeCount;
    this.skinnedMeshCount = init.skinnedMeshCount;
    this.skeletonCount = init.skeletonCount;
    this.template = init.template;
    this.fingerprint = init.fingerprint;
    this.revision = init.revision ?? 1;
  }

  get isDisposed(): boolean {
    return this.#disposed;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;

    for (const mat of this.materials) {
      mat.dispose();
    }
    this.materials.clear();

    for (const skel of this.skeletons) {
      skel.dispose();
    }
    this.skeletons.clear();

    this.scene.removeFromParent();
    this.template.releaseInstance(this);
  }
}

export class ModelTemplateCache {
  #templates = new Map<string, ModelAssetTemplate>();
  #templateRevisions = new Map<string, number>();
  #inFlightLoads = new Map<string, Promise<ModelAssetTemplate>>();
  #parseCount = 0;

  get parseCount(): number {
    return this.#parseCount;
  }

  has(assetId: string): boolean {
    const tmpl = this.#templates.get(assetId);
    return tmpl !== undefined && !tmpl.isDisposed;
  }

  get(assetId: string): ModelAssetTemplate | undefined {
    const tmpl = this.#templates.get(assetId);
    if (tmpl && tmpl.isDisposed) {
      this.#templates.delete(assetId);
      return undefined;
    }
    return tmpl;
  }

  invalidate(assetId: string): void {
    this.#templates.delete(assetId);
    this.#inFlightLoads.delete(assetId);
  }

  async resolveNewTemplate(
    assetId: string,
    resolver: AssetResolver,
    loader: GLTFLoader = new GLTFLoader(),
  ): Promise<ModelAssetTemplate> {
    this.invalidate(assetId);
    return this.resolveTemplate(assetId, resolver, loader);
  }

  async resolveTemplate(
    assetId: string,
    resolver: AssetResolver,
    loader: GLTFLoader = new GLTFLoader(),
  ): Promise<ModelAssetTemplate> {
    const existing = this.get(assetId);
    if (existing) {
      return existing;
    }

    const inFlight = this.#inFlightLoads.get(assetId);
    if (inFlight) {
      return inFlight;
    }

    const loadPromise = (async () => {
      try {
        const resolved = await resolver.resolve(assetId);
        if (!resolved) {
          throw new Error(`Asset "${assetId}" could not be resolved`);
        }

        const createTemplate = (gltf: GLTF): ModelAssetTemplate => {
          const revision = (this.#templateRevisions.get(assetId) ?? 0) + 1;
          this.#templateRevisions.set(assetId, revision);
          const fingerprint = resolver.getFingerprint ? resolver.getFingerprint(assetId) : undefined;
          const template = new ModelAssetTemplate(assetId, `tmpl_${assetId}_r${revision}`, gltf, {
            fingerprint,
            revision,
          });
          this.#templates.set(assetId, template);
          return template;
        };

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
              this.#parseCount++;
              const gltf = await loader.loadAsync(resolved);
              if (!gltf || !gltf.scene) {
                throw new Error(
                  `[model.instance.templateInvalid] Model "${assetId}" contains no valid scene`,
                );
              }
              return createTemplate(gltf);
            }
          } else {
            this.#parseCount++;
            const gltf = await loader.loadAsync(resolved);
            if (!gltf || !gltf.scene) {
              throw new Error(
                `[model.instance.templateInvalid] Model "${assetId}" contains no valid scene`,
              );
            }
            return createTemplate(gltf);
          }
        } else {
          throw new Error(`Unsupported asset resolution type for "${assetId}"`);
        }

        this.#parseCount++;
        let gltf: GLTF;
        try {
          gltf = await loader.parseAsync(arrayBuffer, "");
        } catch (err) {
          throw new Error(
            `[model.instance.templateInvalid] Failed to parse model "${assetId}": ${err instanceof Error ? err.message : String(err)}`,
          );
        }

        if (!gltf || !gltf.scene) {
          throw new Error(
            `[model.instance.templateInvalid] Model "${assetId}" contains no valid scene`,
          );
        }

        return createTemplate(gltf);
      } finally {
        this.#inFlightLoads.delete(assetId);
      }
    })();

    this.#inFlightLoads.set(assetId, loadPromise);
    return loadPromise;
  }

  dispose(): void {
    this.#inFlightLoads.clear();
    for (const template of this.#templates.values()) {
      template.dispose();
    }
    this.#templates.clear();
  }
}
