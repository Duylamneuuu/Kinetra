import * as THREE from "three";

export interface RenderStats {
  calls: number;
  triangles: number;
  points: number;
  lines: number;
}

export interface RenderBackend {
  initialize(canvas: HTMLCanvasElement): Promise<void>;
  render(scene: THREE.Scene, camera: THREE.Camera): void;
  resize(width: number, height: number, dpr: number): void;
  getStats(): RenderStats;
  dispose(): Promise<void>;
}

export class WebGL2Backend implements RenderBackend {
  #renderer: THREE.WebGLRenderer | undefined;

  async initialize(canvas: HTMLCanvasElement): Promise<void> {
    if (this.#renderer) {
      throw new Error("WebGL2Backend is already initialized");
    }

    this.#renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: "high-performance",
    });
  }

  render(scene: THREE.Scene, camera: THREE.Camera): void {
    this.#requireRenderer().render(scene, camera);
  }

  resize(width: number, height: number, dpr: number): void {
    const renderer = this.#requireRenderer();
    renderer.setPixelRatio(Math.max(0.25, dpr));
    renderer.setSize(width, height, false);
  }

  getStats(): RenderStats {
    const render = this.#requireRenderer().info.render;
    return {
      calls: render.calls,
      triangles: render.triangles,
      points: render.points,
      lines: render.lines,
    };
  }

  async dispose(): Promise<void> {
    this.#renderer?.dispose();
    this.#renderer = undefined;
  }

  #requireRenderer(): THREE.WebGLRenderer {
    if (!this.#renderer) {
      throw new Error("WebGL2Backend has not been initialized");
    }
    return this.#renderer;
  }
}
