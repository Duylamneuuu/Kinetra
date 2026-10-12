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

/** The slice of THREE.WebGLRenderer the backend uses; lets tests inject a stub renderer. */
export type WebGL2RendererLike = Pick<THREE.WebGLRenderer, "render" | "setPixelRatio" | "setSize" | "dispose" | "info">;

export interface WebGL2BackendOptions {
  createRenderer?: ((canvas: HTMLCanvasElement) => WebGL2RendererLike) | undefined;
}

/** Thrown by RenderBackend.resize when width or height is not a finite, non-negative number. */
export class RenderBackendError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RenderBackendError";
    this.code = code;
  }
}

export class WebGL2Backend implements RenderBackend {
  #renderer: WebGL2RendererLike | undefined;
  readonly #createRenderer: (canvas: HTMLCanvasElement) => WebGL2RendererLike;

  constructor(options: WebGL2BackendOptions = {}) {
    this.#createRenderer =
      options.createRenderer ??
      ((canvas) =>
        new THREE.WebGLRenderer({
          canvas,
          antialias: true,
          alpha: false,
          powerPreference: "high-performance",
        }));
  }

  async initialize(canvas: HTMLCanvasElement): Promise<void> {
    if (this.#renderer) {
      throw new Error("WebGL2Backend is already initialized");
    }

    this.#renderer = this.#createRenderer(canvas);
  }

  render(scene: THREE.Scene, camera: THREE.Camera): void {
    this.#requireRenderer().render(scene, camera);
  }

  resize(width: number, height: number, dpr: number): void {
    const renderer = this.#requireRenderer();
    // Validate before touching the renderer so a rejected resize leaves it unchanged.
    for (const [name, value] of [
      ["width", width],
      ["height", height],
    ] as const) {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new RenderBackendError(
          "renderer.resize.invalidSize",
          `WebGL2Backend.resize ${name} must be a finite, non-negative number (got ${String(value)})`,
        );
      }
    }
    // NaN/Infinity/non-positive dpr (Math.max would propagate NaN and pass Infinity) fall back to 1.
    const pixelRatio = typeof dpr === "number" && Number.isFinite(dpr) && dpr > 0 ? Math.max(0.25, dpr) : 1;
    renderer.setPixelRatio(pixelRatio);
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

  #requireRenderer(): WebGL2RendererLike {
    if (!this.#renderer) {
      throw new Error("WebGL2Backend has not been initialized");
    }
    return this.#renderer;
  }
}
