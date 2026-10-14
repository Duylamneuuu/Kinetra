import assert from "node:assert/strict";
import test from "node:test";
import { normalizeGlb } from "../src/index.js";

function glbFromJson(json: unknown): Uint8Array {
  let text = JSON.stringify(json);
  while (text.length % 4 !== 0) text += " ";
  const chunk = new TextEncoder().encode(text);
  const out = new Uint8Array(20 + chunk.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, out.length, true);
  view.setUint32(12, chunk.length, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.set(chunk, 20);
  return out;
}

const base = {
  asset: { version: "2.0" },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ name: "n" }],
};

test("normalizeGlb reports optional extensions the rewrite dropped instead of losing them silently", async () => {
  const input = glbFromJson({
    ...base,
    extensionsUsed: ["KHR_texture_transform", "KHR_materials_emissive_strength", "KHR_texture_transform"],
    materials: [
      {
        name: "glow",
        emissiveFactor: [1, 1, 1],
        extensions: { KHR_materials_emissive_strength: { emissiveStrength: 5 } },
      },
    ],
  });
  const result = await normalizeGlb(input);
  assert.deepEqual(result.droppedExtensions, ["KHR_materials_emissive_strength", "KHR_texture_transform"]);
  assert.equal(result.materialCount, 1);
});

test("normalizeGlb reports no dropped extensions for a plain GLB", async () => {
  const result = await normalizeGlb(glbFromJson({ ...base, materials: [{ name: "plain" }] }));
  assert.deepEqual(result.droppedExtensions, []);
});

test("normalizeGlb does not write to the console for an unregistered optional extension", async () => {
  const original = { warn: console.warn, log: console.log, info: console.info };
  const lines: string[] = [];
  console.warn = console.log = console.info = (...args: unknown[]): void => {
    lines.push(args.join(" "));
  };
  try {
    await normalizeGlb(glbFromJson({ ...base, extensionsUsed: ["KHR_texture_transform"] }));
  } finally {
    Object.assign(console, original);
  }
  assert.deepEqual(lines, []);
});
