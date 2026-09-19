import { readFile } from "node:fs/promises";
import { inspectGlb, normalizeGlb } from "../dist/src/index.js";

const [path] = process.argv.slice(2);
if (!path) throw new Error("Usage: node validate-glb.mjs <file.glb>");

const bytes = new Uint8Array(await readFile(path));
const header = inspectGlb(bytes);
const normalized = await normalizeGlb(bytes);

console.log(JSON.stringify({
  path,
  header,
  beforeBytes: normalized.beforeBytes,
  afterBytes: normalized.afterBytes,
  nodeCount: normalized.nodeCount,
  meshCount: normalized.meshCount,
  animationCount: normalized.animationCount,
  materialCount: normalized.materialCount,
  textureCount: normalized.textureCount,
}, null, 2));

if (normalized.meshCount < 1) {
  throw new Error("Expected Blender fixture GLB to contain at least one mesh");
}
