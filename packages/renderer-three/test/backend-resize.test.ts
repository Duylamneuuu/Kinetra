import assert from "node:assert/strict";
import test from "node:test";
import { RenderBackendError, WebGL2Backend, type WebGL2RendererLike } from "../src/index.js";

interface Calls {
  pixelRatio: number[];
  size: Array<[number, number, boolean | undefined]>;
}

async function makeBackend(): Promise<{ backend: WebGL2Backend; calls: Calls }> {
  const calls: Calls = { pixelRatio: [], size: [] };
  const stub = {
    render() {},
    dispose() {},
    info: { render: { calls: 0, triangles: 0, points: 0, lines: 0 } },
    setPixelRatio(value: number) {
      calls.pixelRatio.push(value);
    },
    setSize(width: number, height: number, updateStyle?: boolean) {
      calls.size.push([width, height, updateStyle]);
    },
  } as unknown as WebGL2RendererLike;
  const backend = new WebGL2Backend({ createRenderer: () => stub });
  await backend.initialize({} as HTMLCanvasElement);
  return { backend, calls };
}

test("resize forwards finite size and dpr, clamping dpr to at least 0.25", async () => {
  const { backend, calls } = await makeBackend();
  backend.resize(640, 480, 2);
  backend.resize(0, 0, 0.1);
  assert.deepEqual(calls.pixelRatio, [2, 0.25]);
  assert.deepEqual(calls.size, [
    [640, 480, false],
    [0, 0, false],
  ]);
});

test("resize falls back to dpr 1 for NaN, Infinity and non-positive dpr", async () => {
  const { backend, calls } = await makeBackend();
  for (const dpr of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -2]) {
    backend.resize(100, 100, dpr);
  }
  assert.deepEqual(calls.pixelRatio, [1, 1, 1, 1, 1]);
  assert.equal(calls.size.length, 5);
});

test("resize rejects non-finite or negative width/height with a coded error and leaves the renderer untouched", async () => {
  const { backend, calls } = await makeBackend();
  const bad: Array<[number, number]> = [
    [Number.NaN, 10],
    [10, Number.NaN],
    [Number.POSITIVE_INFINITY, 10],
    [10, Number.NEGATIVE_INFINITY],
    [-1, 10],
    [10, -1],
  ];
  for (const [width, height] of bad) {
    assert.throws(
      () => backend.resize(width, height, 1),
      (error: unknown) => error instanceof RenderBackendError && error.code === "renderer.resize.invalidSize",
    );
  }
  assert.deepEqual(calls.pixelRatio, []);
  assert.deepEqual(calls.size, []);
});

test("resize before initialize still throws the not-initialized error", () => {
  const backend = new WebGL2Backend({ createRenderer: () => ({}) as WebGL2RendererLike });
  assert.throws(() => backend.resize(1, 1, 1), /not been initialized/);
});
