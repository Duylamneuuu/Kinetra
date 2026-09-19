import type { ProjectDocument } from "@kinetra/project-model";
import { ThreeSceneRuntime } from "@kinetra/renderer-three";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";

export interface ViewportStats {
  calls: number;
  triangles: number;
  objects: number;
}

export interface ViewportOptions {
  onSelect(entityId: string | null): void;
  onTransformCommit(
    entityId: string,
    transform: {
      position: [number, number, number];
      rotation: [number, number, number];
      scale: [number, number, number];
    },
  ): void | Promise<void>;
  onStats?(stats: ViewportStats): void;
}

export class ViewportController {
  readonly renderer: THREE.WebGLRenderer;
  readonly camera: THREE.PerspectiveCamera;
  readonly orbit: OrbitControls;
  readonly transform: TransformControls;

  #runtime: ThreeSceneRuntime | undefined;
  #sceneId: string | undefined;
  #selectedId: string | null = null;
  #frame = 0;
  #disposed = false;
  #dragging = false;
  #animationHandle = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly options: ViewportOptions,
  ) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    this.camera = new THREE.PerspectiveCamera(55, 1, 0.05, 5000);
    this.camera.position.set(5, 4, 7);

    this.orbit = new OrbitControls(this.camera, canvas);
    this.orbit.target.set(0, 1, 0);
    this.orbit.update();

    this.transform = new TransformControls(this.camera, canvas);
    this.transform.setMode("translate");

    this.transform.addEventListener("dragging-changed", (event) => {
      const value = (event as unknown as { value?: boolean }).value ?? false;
      this.#dragging = value;
      this.orbit.enabled = !value;
    });

    this.transform.addEventListener("mouseUp", () => {
      void this.#commitTransform();
    });

    canvas.addEventListener("pointerdown", this.#onPointerDown);
    window.addEventListener("resize", this.resize);

    this.resize();
    this.#animate();
  }

  load(project: ProjectDocument, sceneId: string): void {
    const selectedId = this.#selectedId;
    this.transform.detach();
    this.#runtime?.dispose();

    this.#runtime = ThreeSceneRuntime.instantiate(project, sceneId);
    this.#sceneId = sceneId;
    this.#runtime.scene.background = new THREE.Color("#10131a");
    this.#runtime.scene.add(new THREE.GridHelper(20, 20, "#4d607b", "#253044"));

    const helperLight = new THREE.HemisphereLight("#aac8ff", "#1d2433", 0.7);
    helperLight.userData.kinetraEditorOnly = true;
    this.#runtime.scene.add(helperLight);

    if (selectedId) {
      this.select(selectedId);
    }
  }

  select(entityId: string | null): void {
    this.#selectedId = entityId;
    this.options.onSelect(entityId);

    if (!entityId || !this.#runtime) {
      this.transform.detach();
      return;
    }

    const object = this.#runtime.getObject(entityId);
    if (!object) {
      this.transform.detach();
      return;
    }

    this.transform.attach(object);
    this.#runtime.scene.add(this.transform.getHelper());
  }

  setTransformMode(mode: "translate" | "rotate" | "scale"): void {
    this.transform.setMode(mode);
  }

  stats(): ViewportStats {
    return {
      calls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
      objects: this.#runtime?.objects().size ?? 0,
    };
  }

  resize = (): void => {
    const rect = this.canvas.getBoundingClientRect();
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));

    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  };

  dispose(): void {
    if (this.#disposed) {
      return;
    }

    this.#disposed = true;
    cancelAnimationFrame(this.#animationHandle);
    this.canvas.removeEventListener("pointerdown", this.#onPointerDown);
    window.removeEventListener("resize", this.resize);
    this.transform.detach();
    this.transform.dispose();
    this.orbit.dispose();
    this.#runtime?.dispose();
    this.renderer.dispose();
  }

  #onPointerDown = (event: PointerEvent): void => {
    if (this.#dragging || !this.#runtime) {
      return;
    }

    const rect = this.canvas.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );

    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(pointer, this.camera);

    const hits = raycaster.intersectObjects(
      [...this.#runtime.objects().values()],
      true,
    );

    for (const hit of hits) {
      let cursor: THREE.Object3D | null = hit.object;

      while (cursor) {
        const entityId = cursor.userData?.kinetra?.entityId;
        if (typeof entityId === "string") {
          this.select(entityId);
          return;
        }
        cursor = cursor.parent;
      }
    }

    this.select(null);
  };

  async #commitTransform(): Promise<void> {
    const object = this.transform.object;
    const entityId = this.#selectedId;

    if (!object || !entityId) {
      return;
    }

    await this.options.onTransformCommit(entityId, {
      position: [object.position.x, object.position.y, object.position.z],
      rotation: [object.rotation.x, object.rotation.y, object.rotation.z],
      scale: [object.scale.x, object.scale.y, object.scale.z],
    });
  }

  #animate = (): void => {
    if (this.#disposed) {
      return;
    }

    this.#animationHandle = requestAnimationFrame(this.#animate);
    this.orbit.update();

    if (this.#runtime) {
      this.renderer.render(this.#runtime.scene, this.camera);
    }

    this.#frame += 1;
    if (this.#frame % 30 === 0) {
      this.options.onStats?.(this.stats());
    }
  };
}
