import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { WebGL2Backend, type WebGL2RendererLike } from "../src/index.js";

interface StubState {
  created: number;
  canvases: unknown[];
  rendered: Array<[THREE.Scene, THREE.Camera]>;
  disposed: number;
  info: { render: { calls: number; triangles: number; points: number; lines: number } };
}

function makeStub(): { stub: WebGL2RendererLike; state: StubState } {
  const state: StubState = {
    created: 0,
    canvases: [],
    rendered: [],
    disposed: 0,
    info: { render: { calls: 3, triangles: 12, points: 5, lines: 7 } },
  };
  const stub = {
    render(scene: THREE.Scene, camera: THREE.Camera) {
      state.rendered.push([scene, camera]);
    },
    setPixelRatio() {},
    setSize() {},
    dispose() {
      state.disposed += 1;
    },
    info: state.info,
  } as unknown as WebGL2RendererLike;
  return { stub, state };
}

function makeBackend(): { backend: WebGL2Backend; state: StubState } {
  const { stub, state } = makeStub();
  const backend = new WebGL2Backend({
    createRenderer: (canvas) => {
      state.created += 1;
      state.canvases.push(canvas);
      return stub;
    },
  });
  return { backend, state };
}

const canvas = { id: "canvas" } as unknown as HTMLCanvasElement;

test("initialize creates the renderer once from the given canvas and refuses a second initialize", async () => {
  const { backend, state } = makeBackend();
  await backend.initialize(canvas);
  assert.equal(state.created, 1);
  assert.deepEqual(state.canvases, [canvas]);
  await assert.rejects(() => backend.initialize(canvas), /already initialized/);
  assert.equal(state.created, 1);
});

test("render forwards the scene and camera to the renderer", async () => {
  const { backend, state } = makeBackend();
  await backend.initialize(canvas);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  backend.render(scene, camera);
  assert.equal(state.rendered.length, 1);
  assert.equal(state.rendered[0]?.[0], scene);
  assert.equal(state.rendered[0]?.[1], camera);
});

test("getStats copies the renderer's per-frame info instead of exposing it", async () => {
  const { backend, state } = makeBackend();
  await backend.initialize(canvas);
  const stats = backend.getStats();
  assert.deepEqual(stats, { calls: 3, triangles: 12, points: 5, lines: 7 });
  state.info.render.calls = 99;
  assert.equal(stats.calls, 3, "a returned snapshot must not follow later renderer updates");
  assert.equal(backend.getStats().calls, 99);
});

test("render and getStats before initialize throw the not-initialized error", () => {
  const { backend } = makeBackend();
  assert.throws(() => backend.render(new THREE.Scene(), new THREE.PerspectiveCamera()), /not been initialized/);
  assert.throws(() => backend.getStats(), /not been initialized/);
});

test("dispose releases the renderer once, is idempotent, and allows a fresh initialize", async () => {
  const { backend, state } = makeBackend();
  await backend.dispose();
  assert.equal(state.disposed, 0, "dispose before initialize is a no-op");

  await backend.initialize(canvas);
  await backend.dispose();
  await backend.dispose();
  assert.equal(state.disposed, 1);
  assert.throws(() => backend.getStats(), /not been initialized/);
  assert.throws(() => backend.resize(1, 1, 1), /not been initialized/);

  await backend.initialize(canvas);
  assert.equal(state.created, 2);
  assert.equal(backend.getStats().calls, 3);
});
