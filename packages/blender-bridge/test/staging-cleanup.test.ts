import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSyntheticGlb } from "@kinetra/asset-pipeline";
import { BlenderGlbImporter, type ProcessRunner } from "../src/index.js";

/** Pretends to be Blender: writes the GLB and the manifest sidecar export_glb.py leaves behind. */
function fakeBlender(targetPath: string, glb: Uint8Array | string): ProcessRunner {
  return {
    async run() {
      await writeFile(targetPath, glb);
      await writeFile(`${targetPath}.manifest.json`, JSON.stringify({ blenderVersion: "4.2.0", meshes: ["M"] }));
      return { code: 0, stdout: "KINETRA_BLENDER_EXPORT_OK", stderr: "" };
    },
  };
}

const context = (targetPath: string) => ({
  assetId: "asset_hero",
  sourcePath: "/project/hero.blend",
  sourceBytes: new Uint8Array([1, 2, 3]),
  sourceHash: "0".repeat(64),
  recipe: { importer: "blender-glb", importerVersion: "1", settings: {} },
  targetPath,
});

test("a successful import removes the manifest sidecar it caused Blender to write", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kinetra-blender-staging-"));
  try {
    const targetPath = join(dir, "hero.tmp.1.abc123.glb");
    const glb = await createSyntheticGlb({ size: [1, 1, 1], meshName: "M" });
    const importer = new BlenderGlbImporter({ blenderExecutable: "blender", runner: fakeBlender(targetPath, glb) });

    const result = await importer.import(context(targetPath));

    // The manifest content was still forwarded before it was cleaned up.
    assert.deepEqual((result.metadata as { custom?: { meshes?: string[] } }).custom?.meshes, ["M"]);
    const leftovers = (await readdir(dir)).filter((name) => name !== "hero.tmp.1.abc123.glb");
    assert.deepEqual(leftovers, [], "manifest sidecar leaked into the asset directory");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a failed import (invalid GLB) also removes the manifest sidecar", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kinetra-blender-staging-fail-"));
  try {
    const targetPath = join(dir, "hero.tmp.2.def456.glb");
    const importer = new BlenderGlbImporter({
      blenderExecutable: "blender",
      runner: fakeBlender(targetPath, "definitely not a glb"),
    });

    await assert.rejects(importer.import(context(targetPath)));

    const leftovers = (await readdir(dir)).filter((name) => name !== "hero.tmp.2.def456.glb");
    assert.deepEqual(leftovers, [], "manifest sidecar leaked after a failed import");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
