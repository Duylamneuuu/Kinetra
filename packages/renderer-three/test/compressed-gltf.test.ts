import assert from "node:assert/strict";
import test from "node:test";

import {
  RUNTIME_DECODER_CAPABILITIES,
  checkGlbCompression,
} from "@kinetra/asset-pipeline";
import { MeshoptEncoder } from "meshoptimizer";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

import { RUNTIME_GLTF_DECODERS, createRuntimeGltfLoader } from "../src/index.js";

const POSITIONS = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0.5]);
const INDICES = new Uint16Array([0, 1, 2, 0, 2, 3]);

/** A real EXT_meshopt_compression GLB: compressed vertex and index buffers. */
async function createMeshoptGlb(): Promise<Uint8Array> {
  await MeshoptEncoder.ready;
  const vertices = MeshoptEncoder.encodeVertexBuffer(new Uint8Array(POSITIONS.buffer), 4, 12);
  const indices = MeshoptEncoder.encodeIndexBuffer(new Uint8Array(INDICES.buffer), 6, 2);
  const pad = (n: number): number => Math.ceil(n / 4) * 4;
  const vertexOffset = 0;
  const indexOffset = pad(vertices.byteLength);
  const binLength = pad(indexOffset + indices.byteLength);
  const bin = new Uint8Array(binLength);
  bin.set(vertices, vertexOffset);
  bin.set(indices, indexOffset);

  const json = {
    asset: { version: "2.0" },
    extensionsUsed: ["EXT_meshopt_compression"],
    extensionsRequired: ["EXT_meshopt_compression"],
    buffers: [
      { byteLength: binLength },
      { byteLength: POSITIONS.byteLength + INDICES.byteLength, extensions: { EXT_meshopt_compression: { fallback: true } } },
    ],
    bufferViews: [
      {
        buffer: 1,
        byteOffset: 0,
        byteLength: POSITIONS.byteLength,
        byteStride: 12,
        target: 34962,
        extensions: {
          EXT_meshopt_compression: {
            buffer: 0,
            byteOffset: vertexOffset,
            byteLength: vertices.byteLength,
            byteStride: 12,
            count: 4,
            mode: "ATTRIBUTES",
          },
        },
      },
      {
        buffer: 1,
        byteOffset: POSITIONS.byteLength,
        byteLength: INDICES.byteLength,
        target: 34963,
        extensions: {
          EXT_meshopt_compression: {
            buffer: 0,
            byteOffset: indexOffset,
            byteLength: indices.byteLength,
            byteStride: 2,
            count: 6,
            mode: "TRIANGLES",
          },
        },
      },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 4, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0.5] },
      { bufferView: 1, componentType: 5123, count: 6, type: "SCALAR" },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    nodes: [{ mesh: 0 }],
    scenes: [{ nodes: [0] }],
    scene: 0,
  };
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonLength = pad(jsonBytes.length);
  const total = 12 + 8 + jsonLength + 8 + binLength;
  const glb = new Uint8Array(total);
  const view = new DataView(glb.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  glb.set(jsonBytes, 20);
  glb.fill(0x20, 20 + jsonBytes.length, 20 + jsonLength);
  view.setUint32(20 + jsonLength, binLength, true);
  view.setUint32(24 + jsonLength, 0x004e4942, true);
  glb.set(bin, 28 + jsonLength);
  return glb;
}

function arrayBufferOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

test("runtime loader decodes a real EXT_meshopt_compression GLB", async () => {
  const glb = await createMeshoptGlb();
  const gltf = await createRuntimeGltfLoader().parseAsync(arrayBufferOf(glb), "");
  const meshes: THREE.Mesh[] = [];
  gltf.scene.traverse((object) => {
    if (object instanceof THREE.Mesh) meshes.push(object);
  });
  assert.equal(meshes.length, 1);
  const geometry = meshes[0]!.geometry as THREE.BufferGeometry;
  assert.deepEqual(Array.from(geometry.getAttribute("position").array), Array.from(POSITIONS));
  assert.deepEqual(Array.from(geometry.getIndex()!.array), Array.from(INDICES));
});

test("a stock GLTFLoader cannot load the same file, so the runtime wiring is what makes it work", async () => {
  const glb = await createMeshoptGlb();
  await assert.rejects(() => new GLTFLoader().parseAsync(arrayBufferOf(glb), ""), /meshopt/i);
});

test("each runtime loader is independent", () => {
  assert.notEqual(createRuntimeGltfLoader(), createRuntimeGltfLoader());
});

test("the asset pipeline's capability table matches the runtime loader", async () => {
  assert.deepEqual({ ...RUNTIME_DECODER_CAPABILITIES }, { ...RUNTIME_GLTF_DECODERS });
  const { diagnostics } = checkGlbCompression(await createMeshoptGlb());
  assert.equal(diagnostics.some((d) => d.severity === "error"), false);
  assert.ok(diagnostics.some((d) => d.code === "asset.compression.meshopt.supported"));
});
