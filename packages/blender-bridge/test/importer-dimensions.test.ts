import assert from "node:assert/strict";
import test from "node:test";
import { createSyntheticGlb } from "@kinetra/asset-pipeline";
import { BlenderGlbImporter, type ProcessRunner } from "../src/index.js";

class WritingRunner implements ProcessRunner {
  constructor(private readonly write: () => void) {}
  async run(): Promise<{ code: number; stdout: string; stderr: string }> {
    this.write();
    return { code: 0, stdout: "", stderr: "" };
  }
}

function memoryFs(files: Map<string, Uint8Array>) {
  return {
    async readFile(path: string): Promise<Uint8Array> {
      const data = files.get(path);
      if (!data) throw new Error(`ENOENT: ${path}`);
      return data;
    },
  };
}

async function importGlb(glb: Uint8Array) {
  const files = new Map<string, Uint8Array>();
  const importer = new BlenderGlbImporter({
    runner: new WritingRunner(() => files.set("/staging/out.glb", glb)),
    fileSystem: memoryFs(files),
  });
  return importer.import({
    assetId: "asset_dims",
    sourcePath: "/source/model.blend",
    sourceBytes: new Uint8Array([0]),
    sourceHash: "h",
    recipe: { importer: "blender-glb", importerVersion: "1.0.0", settings: {} },
    targetPath: "/staging/out.glb",
  });
}

test("BlenderGlbImporter reports the measured bounding-box size, not a made-up [1, 1, 1]", async () => {
  const glb = await createSyntheticGlb({ size: [2, 3, 4], meshName: "Box" });
  const result = await importGlb(glb);
  assert.deepEqual(result.metadata?.dimensions, [2, 3, 4]);
});

test("BlenderGlbImporter leaves dimensions out when the GLB body cannot be measured", async () => {
  // Valid 12-byte GLB header (magic, version 2, length 12) with no chunks: passes inspectGlb, has no geometry.
  const header = new Uint8Array(12);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, 12, true);
  const result = await importGlb(header);
  assert.equal(result.metadata?.dimensions, undefined);
});
