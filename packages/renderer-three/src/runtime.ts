import type {
  EntityDefinition,
  ProjectDocument,
  SceneDefinition,
} from "@kinetra/project-model";
import * as THREE from "three";

import { asObject, numberValue, stringValue, vec3Value } from "./components.js";

function makePrimitive(entity: EntityDefinition): THREE.Mesh | undefined {
  const primitive = asObject(entity.components.Primitive);
  if (!primitive) {
    return undefined;
  }

  const kind = stringValue(primitive.kind, "box");
  const color = new THREE.Color(stringValue(primitive.color, "#d9e6ff"));
  const material = new THREE.MeshStandardMaterial({
    color,
    roughness: numberValue(primitive.roughness, 0.6),
    metalness: numberValue(primitive.metalness, 0),
  });

  switch (kind) {
    case "box": {
      const size = vec3Value(primitive.size, [1, 1, 1]);
      return new THREE.Mesh(
        new THREE.BoxGeometry(size[0], size[1], size[2]),
        material,
      );
    }
    case "sphere":
      return new THREE.Mesh(
        new THREE.SphereGeometry(numberValue(primitive.radius, 0.5), 24, 16),
        material,
      );
    case "plane": {
      const size = vec3Value(primitive.size, [1, 1, 1]);
      return new THREE.Mesh(
        new THREE.PlaneGeometry(size[0], size[1]),
        material,
      );
    }
    default:
      material.dispose();
      throw new Error(
        `Unsupported Primitive.kind "${kind}" for entity "${entity.id}"`,
      );
  }
}

function makeObject(entity: EntityDefinition): THREE.Object3D {
  const camera = asObject(entity.components.Camera);
  if (camera) {
    const type = stringValue(camera.type, "perspective");
    if (type !== "perspective") {
      throw new Error(
        `Unsupported Camera.type "${type}" for entity "${entity.id}"`,
      );
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
        throw new Error(
          `Unsupported Light.kind "${kind}" for entity "${entity.id}"`,
        );
    }
  }

  return makePrimitive(entity) ?? new THREE.Group();
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

function disposeObjectResources(object: THREE.Object3D): void {
  const mesh = object as THREE.Mesh;
  if (mesh.isMesh) {
    mesh.geometry?.dispose();

    const materials = Array.isArray(mesh.material)
      ? mesh.material
      : [mesh.material];

    for (const material of materials) {
      material.dispose();
    }
  }
}

export class ThreeSceneRuntime {
  readonly scene = new THREE.Scene();
  readonly sceneId: string;
  #objects = new Map<string, THREE.Object3D>();
  #disposed = false;

  private constructor(sceneDefinition: SceneDefinition) {
    this.sceneId = sceneDefinition.id;
    this.scene.name = sceneDefinition.name;

    for (const entity of sceneDefinition.entities) {
      const object = makeObject(entity);
      applyTransform(object, entity);
      decorateObject(object, entity);
      this.#objects.set(entity.id, object);
    }

    for (const entity of sceneDefinition.entities) {
      const object = this.#objects.get(entity.id);
      if (!object) {
        throw new Error(
          `Runtime object missing for entity "${entity.id}"`,
        );
      }

      if (entity.parentId) {
        const parent = this.#objects.get(entity.parentId);
        if (!parent) {
          throw new Error(
            `Runtime parent "${entity.parentId}" missing for "${entity.id}"`,
          );
        }
        parent.add(object);
      } else {
        this.scene.add(object);
      }
    }
  }

  static instantiate(
    project: ProjectDocument,
    sceneId: string,
  ): ThreeSceneRuntime {
    const scene = project.scenes.find((candidate) => candidate.id === sceneId);
    if (!scene) {
      throw new Error(`Scene "${sceneId}" does not exist`);
    }
    return new ThreeSceneRuntime(scene);
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

  dispose(): void {
    if (this.#disposed) {
      return;
    }

    for (const object of this.#objects.values()) {
      disposeObjectResources(object);
      object.removeFromParent();
    }

    this.scene.clear();
    this.#objects.clear();
    this.#disposed = true;
  }
}
