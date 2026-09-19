import { NodeIO } from "@gltf-transform/core";

export interface NormalizeGlbResult {
  bytes: Uint8Array;
  beforeBytes: number;
  afterBytes: number;
  nodeCount: number;
  meshCount: number;
  animationCount: number;
  materialCount: number;
  textureCount: number;
}

/**
 * Parse and rewrite a GLB using glTF-Transform core only.
 *
 * This deliberately avoids @gltf-transform/functions in the engine core:
 * its image toolchain currently introduces LGPL libvips binaries through Sharp.
 * Lossy/advanced optimization remains an optional external build step.
 */
export async function normalizeGlb(bytes: Uint8Array): Promise<NormalizeGlbResult> {
  const io = new NodeIO();
  const document = await io.readBinary(bytes);
  const root = document.getRoot();
  const output = await io.writeBinary(document);

  return {
    bytes: output,
    beforeBytes: bytes.byteLength,
    afterBytes: output.byteLength,
    nodeCount: root.listNodes().length,
    meshCount: root.listMeshes().length,
    animationCount: root.listAnimations().length,
    materialCount: root.listMaterials().length,
    textureCount: root.listTextures().length,
  };
}
