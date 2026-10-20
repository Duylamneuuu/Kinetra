import { Logger, WebIO } from "./gltf-web.js";

export interface NormalizeGlbResult {
  bytes: Uint8Array;
  beforeBytes: number;
  afterBytes: number;
  nodeCount: number;
  meshCount: number;
  animationCount: number;
  materialCount: number;
  textureCount: number;
  /**
   * Optional glTF extensions the input declared in `extensionsUsed` that the
   * rewritten file no longer declares, sorted. `normalizeGlb` registers no
   * glTF-Transform extension, so their data (for example
   * `KHR_materials_emissive_strength` or `KHR_texture_transform`) is lost in
   * the rewrite. Empty when nothing was lost.
   */
  droppedExtensions: string[];
}

/** `extensionsUsed` of a GLB's JSON chunk; empty when it cannot be read. */
function readExtensionsUsed(bytes: Uint8Array): string[] {
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const length = view.getUint32(12, true);
    const json: unknown = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + length)));
    const used = (json as { extensionsUsed?: unknown }).extensionsUsed;
    return Array.isArray(used) ? used.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Parse and rewrite a GLB using glTF-Transform core only.
 *
 * This deliberately avoids @gltf-transform/functions in the engine core:
 * its image toolchain currently introduces LGPL libvips binaries through Sharp.
 * Lossy/advanced optimization remains an optional external build step.
 *
 * No glTF-Transform extension is registered, so optional extensions in the
 * input are dropped by the rewrite (a required one makes the read throw). The
 * dropped names are reported in `droppedExtensions`.
 */
export async function normalizeGlb(bytes: Uint8Array): Promise<NormalizeGlbResult> {
  // The library logs "Missing optional extension" to the console for every
  // dropped extension; the result reports them in `droppedExtensions` instead.
  const io = new WebIO().setLogger(new Logger(Logger.Verbosity.SILENT));
  const document = await io.readBinary(bytes);
  const root = document.getRoot();
  const output = await io.writeBinary(document);
  const kept = new Set(readExtensionsUsed(output));
  const droppedExtensions = [...new Set(readExtensionsUsed(bytes))].filter((name) => !kept.has(name)).sort();

  return {
    bytes: output,
    beforeBytes: bytes.byteLength,
    afterBytes: output.byteLength,
    nodeCount: root.listNodes().length,
    meshCount: root.listMeshes().length,
    animationCount: root.listAnimations().length,
    materialCount: root.listMaterials().length,
    textureCount: root.listTextures().length,
    droppedExtensions,
  };
}
