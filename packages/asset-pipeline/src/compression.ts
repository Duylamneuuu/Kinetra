import type { AssetDiagnostic } from "./types.js";

/**
 * Pure glTF/GLB compression inspection and policy.
 *
 * This module reads only the GLB JSON chunk. It never decodes geometry or
 * images, never touches Three.js and never throws on malformed input: every
 * problem becomes a structured diagnostic. It answers two questions:
 *
 *  1. What compression does this GLB use (Meshopt, Draco, KTX2/Basis)?
 *  2. Can the Kinetra runtime decode it, and is an uncompressed payload large
 *     enough that a compression pass would be worth running offline?
 */

export type GlbCompressionCodec = "meshopt" | "draco" | "ktx2";

/** Which compression codecs the runtime loader can decode. */
export type RuntimeDecoderCapabilities = Readonly<Record<GlbCompressionCodec, boolean>>;

/**
 * What the shipped runtime (`@kinetra/renderer-three`) can decode today.
 *
 * Meshopt ships inside three.js as a self-contained WASM module. Draco and
 * KTX2/Basis need external decoder/transcoder files that the packaged player
 * does not carry yet, so they stay off until that is built and proven.
 * `@kinetra/renderer-three` has a test that fails if this drifts from its
 * loader.
 */
export const RUNTIME_DECODER_CAPABILITIES: RuntimeDecoderCapabilities = Object.freeze({
  meshopt: true,
  draco: false,
  ktx2: false,
});

/** Extensions three.js r180 `GLTFLoader` understands (read from its source). */
export const RUNTIME_KNOWN_GLTF_EXTENSIONS: readonly string[] = Object.freeze([
  "EXT_materials_bump",
  "EXT_mesh_gpu_instancing",
  "EXT_meshopt_compression",
  "EXT_texture_avif",
  "EXT_texture_webp",
  "KHR_draco_mesh_compression",
  "KHR_lights_punctual",
  "KHR_materials_anisotropy",
  "KHR_materials_clearcoat",
  "KHR_materials_dispersion",
  "KHR_materials_emissive_strength",
  "KHR_materials_ior",
  "KHR_materials_iridescence",
  "KHR_materials_sheen",
  "KHR_materials_specular",
  "KHR_materials_transmission",
  "KHR_materials_unlit",
  "KHR_materials_variants",
  "KHR_materials_volume",
  "KHR_mesh_quantization",
  "KHR_texture_basisu",
  "KHR_texture_transform",
]);

export interface CompressionPolicy {
  decoders: RuntimeDecoderCapabilities;
  /** Extensions the runtime loader is known to handle. */
  knownExtensions: readonly string[];
  /** Uncompressed geometry above this many bytes triggers a Meshopt advisory. */
  geometryAdvisoryBytes: number;
  /** Embedded PNG/JPEG payload above this many bytes triggers a KTX2 advisory. */
  textureAdvisoryBytes: number;
}

export const DEFAULT_COMPRESSION_POLICY: CompressionPolicy = Object.freeze({
  decoders: RUNTIME_DECODER_CAPABILITIES,
  knownExtensions: RUNTIME_KNOWN_GLTF_EXTENSIONS,
  geometryAdvisoryBytes: 256 * 1024,
  textureAdvisoryBytes: 512 * 1024,
});

export interface MeshoptUsage {
  /** bufferViews that carry EXT_meshopt_compression. */
  bufferViews: number;
  /** Sum of the compressed byteLength fields of those extensions. */
  compressedBytes: number;
}

export interface GlbCompressionReport {
  /** False when the container or its JSON chunk could not be parsed. */
  parsed: boolean;
  extensionsUsed: string[];
  extensionsRequired: string[];
  meshopt: MeshoptUsage;
  /** Primitives carrying KHR_draco_mesh_compression. */
  dracoPrimitives: number;
  /** Textures that reference a KHR_texture_basisu image. */
  ktx2Textures: number;
  /** Embedded (bufferView or data: URI) image bytes by container format. */
  embeddedImageBytes: { png: number; jpeg: number; ktx2: number; other: number };
  /** Images referenced by external URI, whose size is unknown here. */
  externalImages: number;
  /**
   * Bytes of mesh accessors (attributes, indices, morph targets) that are
   * neither Draco- nor Meshopt-compressed. Computed from accessor metadata:
   * dense data counts only when the accessor has a bufferView (an accessor
   * without one is zero-filled and stores nothing), plus sparse indices and
   * values when present.
   */
  uncompressedGeometryBytes: number;
  diagnostics: AssetDiagnostic[];
}

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;

const MESHOPT = "EXT_meshopt_compression";
const DRACO = "KHR_draco_mesh_compression";
const BASISU = "KHR_texture_basisu";

const COMPONENT_BYTES: Record<number, number> = {
  5120: 1,
  5121: 1,
  5122: 2,
  5123: 2,
  5125: 4,
  5126: 4,
};
const TYPE_COMPONENTS: Record<string, number> = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT2: 4,
  MAT3: 9,
  MAT4: 16,
};
const MESHOPT_MODES = new Set(["ATTRIBUTES", "TRIANGLES", "INDICES"]);
const MESHOPT_FILTERS = new Set(["NONE", "OCTAHEDRAL", "QUATERNION", "EXPONENTIAL"]);

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringList(value: unknown): string[] {
  return asArray(value).filter((v): v is string => typeof v === "string");
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function emptyReport(): GlbCompressionReport {
  return {
    parsed: false,
    extensionsUsed: [],
    extensionsRequired: [],
    meshopt: { bufferViews: 0, compressedBytes: 0 },
    dracoPrimitives: 0,
    ktx2Textures: 0,
    embeddedImageBytes: { png: 0, jpeg: 0, ktx2: 0, other: 0 },
    externalImages: 0,
    uncompressedGeometryBytes: 0,
    diagnostics: [],
  };
}

function readJsonChunk(bytes: Uint8Array): { json?: Json; diagnostic?: AssetDiagnostic } {
  const fail = (code: string, message: string): { diagnostic: AssetDiagnostic } => ({
    diagnostic: { severity: "error", code, message },
  });
  if (!(bytes instanceof Uint8Array)) {
    return fail("asset.compression.glb.invalid", "GLB input must be a Uint8Array");
  }
  if (bytes.byteLength < 20) {
    return fail("asset.compression.glb.invalid", "GLB is smaller than header plus first chunk header");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC) {
    return fail("asset.compression.glb.invalid", "Invalid GLB magic");
  }
  if (view.getUint32(4, true) !== 2) {
    return fail("asset.compression.glb.invalid", `Unsupported GLB version ${view.getUint32(4, true)}`);
  }
  const chunkLength = view.getUint32(12, true);
  if (view.getUint32(16, true) !== CHUNK_JSON) {
    return fail("asset.compression.glb.invalid", "First GLB chunk is not JSON");
  }
  if (20 + chunkLength > bytes.byteLength) {
    return fail("asset.compression.glb.invalid", "JSON chunk length exceeds GLB size");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(20, 20 + chunkLength)));
  } catch (error) {
    return fail(
      "asset.compression.json.invalid",
      `GLB JSON chunk is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isObject(parsed)) {
    return fail("asset.compression.json.invalid", "GLB JSON chunk is not an object");
  }
  return { json: parsed };
}

function mimeFromHeader(head: Uint8Array): "png" | "jpeg" | "ktx2" | "other" {
  if (head.length >= 4 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return "png";
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "jpeg";
  if (head.length >= 4 && head[0] === 0xab && head[1] === 0x4b && head[2] === 0x54 && head[3] === 0x58) return "ktx2";
  return "other";
}

function formatFromMime(mime: unknown): "png" | "jpeg" | "ktx2" | "other" {
  if (mime === "image/png") return "png";
  if (mime === "image/jpeg") return "jpeg";
  if (mime === "image/ktx2") return "ktx2";
  return "other";
}

function dataUriBytes(uri: string): { format: "png" | "jpeg" | "ktx2" | "other"; bytes: number } | undefined {
  const match = /^data:([^;,]*)(;base64)?,/.exec(uri);
  if (!match) return undefined;
  const payload = uri.slice(match[0].length);
  if (!match[2]) return { format: formatFromMime(match[1]), bytes: payload.length };
  // Decoded size of base64: 3 bytes per 4 characters, minus one byte per '='
  // padding character (at most two).
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  const bytes = Math.max(0, Math.floor((payload.length * 3) / 4) - padding);
  return { format: formatFromMime(match[1]), bytes };
}

/**
 * Every validity rule of the ratified EXT_meshopt_compression spec ("For the
 * extension object to be valid, the following must hold"), plus the required
 * fields. A file that breaks one of these is rejected by the runtime decoder,
 * so the inspector reports it up front instead.
 */
function meshoptExtensionProblems(ext: unknown, view: Json): string[] {
  const problems: string[] = [];
  if (!isObject(ext)) return ["extension is not an object"];
  if (!isNonNegativeInteger(ext.buffer)) problems.push("buffer must be a non-negative integer");
  if (!isNonNegativeInteger(ext.byteLength)) problems.push("byteLength must be a non-negative integer");
  const count = isNonNegativeInteger(ext.count) && ext.count > 0 ? ext.count : undefined;
  if (count === undefined) problems.push("count must be a positive integer");
  const stride =
    isNonNegativeInteger(ext.byteStride) && ext.byteStride > 0 && ext.byteStride <= 256 ? ext.byteStride : undefined;
  if (stride === undefined) problems.push("byteStride must be an integer in 1..256");
  const mode = typeof ext.mode === "string" && MESHOPT_MODES.has(ext.mode) ? ext.mode : undefined;
  if (mode === undefined) problems.push("mode must be ATTRIBUTES, TRIANGLES or INDICES");
  const filter = ext.filter === undefined ? "NONE" : ext.filter;
  const filterValid = typeof filter === "string" && MESHOPT_FILTERS.has(filter);
  if (!filterValid) problems.push("filter must be NONE, OCTAHEDRAL, QUATERNION or EXPONENTIAL");

  if (mode === "ATTRIBUTES" && stride !== undefined && stride % 4 !== 0) {
    problems.push("ATTRIBUTES mode byteStride must be a multiple of 4");
  }
  if (mode === "TRIANGLES" && count !== undefined && count % 3 !== 0) {
    problems.push("TRIANGLES mode count must be a multiple of 3");
  }
  if ((mode === "TRIANGLES" || mode === "INDICES") && stride !== undefined && stride !== 2 && stride !== 4) {
    problems.push(`${mode} mode byteStride must be 2 or 4`);
  }
  if ((mode === "TRIANGLES" || mode === "INDICES") && filterValid && filter !== "NONE") {
    problems.push(`${mode} mode filter must be NONE`);
  }
  if (stride !== undefined && filterValid) {
    if (filter === "OCTAHEDRAL" && stride !== 4 && stride !== 8) problems.push("OCTAHEDRAL filter byteStride must be 4 or 8");
    if (filter === "QUATERNION" && stride !== 8) problems.push("QUATERNION filter byteStride must be 8");
    if (filter === "EXPONENTIAL" && stride % 4 !== 0) problems.push("EXPONENTIAL filter byteStride must be a multiple of 4");
  }
  if (stride !== undefined && view.byteStride !== undefined && view.byteStride !== stride) {
    problems.push(`parent bufferView byteStride ${String(view.byteStride)} must match extension byteStride ${stride}`);
  }
  if (stride !== undefined && count !== undefined && isNonNegativeInteger(view.byteLength) && view.byteLength !== stride * count) {
    problems.push(`parent bufferView byteLength ${view.byteLength} must equal byteStride * count (${stride * count})`);
  }
  return problems;
}

/**
 * Inspect the compression usage of a GLB from its JSON chunk alone.
 * Never throws; malformed input yields `parsed: false` plus diagnostics.
 */
export function inspectGlbCompression(bytes: Uint8Array): GlbCompressionReport {
  const report = emptyReport();
  const { json, diagnostic } = readJsonChunk(bytes);
  if (!json) {
    if (diagnostic) report.diagnostics.push(diagnostic);
    return report;
  }
  report.parsed = true;
  report.extensionsUsed = stringList(json.extensionsUsed);
  report.extensionsRequired = stringList(json.extensionsRequired);

  const bufferViews = asArray(json.bufferViews);
  const accessors = asArray(json.accessors);
  const images = asArray(json.images);
  const textures = asArray(json.textures);
  const meshes = asArray(json.meshes);

  // Meshopt bufferViews, validated against the extension's required fields.
  const meshoptViews = new Set<number>();
  bufferViews.forEach((view, index) => {
    if (!isObject(view) || !isObject(view.extensions)) return;
    const ext = view.extensions[MESHOPT];
    if (ext === undefined) return;
    meshoptViews.add(index);
    report.meshopt.bufferViews += 1;
    const problems = meshoptExtensionProblems(ext, view);
    if (isObject(ext) && isNonNegativeInteger(ext.byteLength)) report.meshopt.compressedBytes += ext.byteLength;
    if (problems.length > 0) {
      report.diagnostics.push({
        severity: "error",
        code: "asset.compression.meshopt.bufferView.invalid",
        message: `bufferViews[${index}] has an invalid ${MESHOPT}: ${problems.join("; ")}`,
        path: `bufferViews[${index}]`,
      });
    }
  });

  // Geometry accessors that are not compressed.
  const storedViewBytes = (bufferView: unknown, bytes: number): number =>
    isNonNegativeInteger(bufferView) && !meshoptViews.has(bufferView) ? bytes : 0;
  const accessorBytes = (index: unknown): number => {
    if (!isNonNegativeInteger(index)) return 0;
    const accessor = accessors[index];
    if (!isObject(accessor)) return 0;
    const component = typeof accessor.componentType === "number" ? COMPONENT_BYTES[accessor.componentType] : undefined;
    const comps = typeof accessor.type === "string" ? TYPE_COMPONENTS[accessor.type] : undefined;
    if (!component || !comps || !isNonNegativeInteger(accessor.count)) return 0;
    const elementBytes = component * comps;
    // Dense data lives in the bufferView; an accessor without one is
    // zero-initialised and stores nothing in the file.
    let bytes = storedViewBytes(accessor.bufferView, elementBytes * accessor.count);
    // Sparse substitution stores `count` indices plus `count` values.
    const sparse = accessor.sparse;
    if (isObject(sparse) && isNonNegativeInteger(sparse.count)) {
      const indices = isObject(sparse.indices) ? sparse.indices : undefined;
      const values = isObject(sparse.values) ? sparse.values : undefined;
      const indexBytes =
        indices && typeof indices.componentType === "number" ? COMPONENT_BYTES[indices.componentType] ?? 0 : 0;
      if (indices) bytes += storedViewBytes(indices.bufferView, indexBytes * sparse.count);
      if (values) bytes += storedViewBytes(values.bufferView, elementBytes * sparse.count);
    }
    return bytes;
  };
  const countedAccessors = new Set<number>();
  const addAccessor = (index: unknown): void => {
    if (!isNonNegativeInteger(index) || countedAccessors.has(index)) return;
    countedAccessors.add(index);
    report.uncompressedGeometryBytes += accessorBytes(index);
  };
  for (const mesh of meshes) {
    if (!isObject(mesh)) continue;
    for (const primitive of asArray(mesh.primitives)) {
      if (!isObject(primitive)) continue;
      if (isObject(primitive.extensions) && primitive.extensions[DRACO] !== undefined) {
        report.dracoPrimitives += 1;
        continue; // Draco payload replaces the accessors' buffer data.
      }
      if (isObject(primitive.attributes)) {
        for (const accessorIndex of Object.values(primitive.attributes)) addAccessor(accessorIndex);
      }
      addAccessor(primitive.indices);
      for (const target of asArray(primitive.targets)) {
        if (isObject(target)) for (const accessorIndex of Object.values(target)) addAccessor(accessorIndex);
      }
    }
  }

  // KTX2 textures and image payload sizes.
  const ktx2Images = new Set<number>();
  for (const texture of textures) {
    if (!isObject(texture) || !isObject(texture.extensions)) continue;
    const basisu = texture.extensions[BASISU];
    if (isObject(basisu)) {
      report.ktx2Textures += 1;
      if (isNonNegativeInteger(basisu.source)) ktx2Images.add(basisu.source);
    }
  }
  images.forEach((image, index) => {
    if (!isObject(image)) return;
    if (typeof image.uri === "string") {
      const data = dataUriBytes(image.uri);
      if (!data) {
        report.externalImages += 1;
        return;
      }
      report.embeddedImageBytes[ktx2Images.has(index) ? "ktx2" : data.format] += data.bytes;
      return;
    }
    if (isNonNegativeInteger(image.bufferView)) {
      const view = bufferViews[image.bufferView];
      const length = isObject(view) && isNonNegativeInteger(view.byteLength) ? view.byteLength : 0;
      const format = ktx2Images.has(index) ? "ktx2" : formatFromMime(image.mimeType);
      report.embeddedImageBytes[format] += length;
    }
  });

  return report;
}

/**
 * Judge a compression report against a policy. Errors mean the runtime cannot
 * load the asset as-is; warnings mean it loads but the user should act.
 */
export function evaluateCompressionPolicy(
  report: GlbCompressionReport,
  policy: CompressionPolicy = DEFAULT_COMPRESSION_POLICY,
): AssetDiagnostic[] {
  const diagnostics: AssetDiagnostic[] = [...report.diagnostics];
  if (!report.parsed) return diagnostics;

  const used = new Set(report.extensionsUsed);
  const required = new Set(report.extensionsRequired);
  const known = new Set(policy.knownExtensions);

  for (const name of required) {
    if (!used.has(name)) {
      diagnostics.push({
        severity: "warning",
        code: "asset.compression.extension.requiredNotUsed",
        message: `${name} is in extensionsRequired but missing from extensionsUsed`,
        path: "extensionsRequired",
      });
    }
    if (!known.has(name)) {
      diagnostics.push({
        severity: "error",
        code: "asset.compression.extension.unknownRequired",
        message: `Required extension ${name} is not supported by the Kinetra runtime loader. Remove it at export time or re-export without it.`,
        path: "extensionsRequired",
      });
    }
  }

  const codecs: Array<{
    codec: GlbCompressionCodec;
    extension: string;
    present: boolean;
    detail: string;
    advice: string;
  }> = [
    {
      codec: "meshopt",
      extension: MESHOPT,
      present: report.meshopt.bufferViews > 0 || used.has(MESHOPT),
      detail: `${report.meshopt.bufferViews} bufferView(s)`,
      advice: "Re-export without Meshopt compression.",
    },
    {
      codec: "draco",
      extension: DRACO,
      present: report.dracoPrimitives > 0 || used.has(DRACO),
      detail: `${report.dracoPrimitives} primitive(s)`,
      advice: "Re-export with Meshopt compression or without geometry compression; the packaged player carries no Draco decoder yet.",
    },
    {
      codec: "ktx2",
      extension: BASISU,
      present: report.ktx2Textures > 0 || used.has(BASISU),
      detail: `${report.ktx2Textures} texture(s)`,
      advice: "Re-export with PNG/JPEG textures; the packaged player carries no KTX2/Basis transcoder yet.",
    },
  ];

  for (const entry of codecs) {
    if (!entry.present) continue;
    if (policy.decoders[entry.codec]) {
      diagnostics.push({
        severity: "info",
        code: `asset.compression.${entry.codec}.supported`,
        message: `${entry.extension} is used (${entry.detail}) and the runtime can decode it`,
      });
      continue;
    }
    const isRequired = required.has(entry.extension);
    diagnostics.push({
      severity: isRequired ? "error" : "warning",
      code: `asset.compression.${entry.codec}.runtimeUnsupported`,
      message: isRequired
        ? `${entry.extension} is required (${entry.detail}) but the runtime cannot decode it, so loading will fail. ${entry.advice}`
        : `${entry.extension} is used (${entry.detail}) but the runtime cannot decode it; only the uncompressed fallback, if the file has one, will load. ${entry.advice}`,
      path: isRequired ? "extensionsRequired" : "extensionsUsed",
    });
  }

  // Declared vs observed consistency.
  if (report.meshopt.bufferViews > 0 && !used.has(MESHOPT)) {
    diagnostics.push({
      severity: "error",
      code: "asset.compression.meshopt.undeclared",
      message: `bufferViews use ${MESHOPT} but it is missing from extensionsUsed`,
      path: "extensionsUsed",
    });
  }
  if (report.dracoPrimitives > 0 && !used.has(DRACO)) {
    diagnostics.push({
      severity: "error",
      code: "asset.compression.draco.undeclared",
      message: `Primitives use ${DRACO} but it is missing from extensionsUsed`,
      path: "extensionsUsed",
    });
  }
  if (report.ktx2Textures > 0 && !used.has(BASISU)) {
    diagnostics.push({
      severity: "error",
      code: "asset.compression.ktx2.undeclared",
      message: `Textures use ${BASISU} but it is missing from extensionsUsed`,
      path: "extensionsUsed",
    });
  }

  // Advisories: payload is large and uncompressed, and the runtime can decode a better format.
  if (policy.decoders.meshopt && report.uncompressedGeometryBytes > policy.geometryAdvisoryBytes) {
    diagnostics.push({
      severity: "warning",
      code: "asset.compression.geometry.uncompressedLarge",
      message: `${report.uncompressedGeometryBytes} bytes of geometry are uncompressed (threshold ${policy.geometryAdvisoryBytes}). Run an offline Meshopt pass; the runtime decodes it.`,
    });
  }
  const rasterBytes = report.embeddedImageBytes.png + report.embeddedImageBytes.jpeg;
  if (policy.decoders.ktx2 && rasterBytes > policy.textureAdvisoryBytes) {
    diagnostics.push({
      severity: "warning",
      code: "asset.compression.texture.uncompressedLarge",
      message: `${rasterBytes} bytes of PNG/JPEG textures are embedded (threshold ${policy.textureAdvisoryBytes}). Consider KTX2/Basis.`,
    });
  }

  return diagnostics;
}

/** Convenience: inspect and evaluate in one call. */
export function checkGlbCompression(
  bytes: Uint8Array,
  policy: CompressionPolicy = DEFAULT_COMPRESSION_POLICY,
): { report: GlbCompressionReport; diagnostics: AssetDiagnostic[] } {
  const report = inspectGlbCompression(bytes);
  return { report, diagnostics: evaluateCompressionPolicy(report, policy) };
}
