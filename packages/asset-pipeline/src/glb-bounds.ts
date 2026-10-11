/**
 * Bounding-box measurement straight from a GLB's JSON chunk: node transforms plus the POSITION accessors'
 * `min`/`max`. It never decodes geometry, so it works for files that need a decoder the pipeline does not
 * ship (KHR_draco_mesh_compression, EXT_meshopt_compression) and for KHR_mesh_quantization, where
 * gltf-transform refuses to read a file whose `extensionsRequired` it has no extension registered for.
 */

const JSON_CHUNK = 0x4e4f534a;
/** Hierarchies deeper than this are treated as unmeasurable. */
const MAX_NODE_DEPTH = 256;
/**
 * A valid glTF node graph is a forest, so each node is visited at most once per scene that lists it.
 * Malformed files that share children (`children: [i + 1, i + 1]` chains) would otherwise be walked
 * 2^depth times and hang import/hot-reload; past this many visits per node the file is unmeasurable.
 */
const MAX_VISITS_PER_NODE = 4;

type Matrix = number[];

interface GltfAccessor {
  type?: unknown;
  componentType?: unknown;
  normalized?: unknown;
  min?: unknown;
  max?: unknown;
}

interface GltfNode {
  children?: unknown;
  mesh?: unknown;
  matrix?: unknown;
  translation?: unknown;
  rotation?: unknown;
  scale?: unknown;
}

interface GltfDocument {
  scene?: unknown;
  scenes?: Array<{ nodes?: unknown }>;
  nodes?: GltfNode[];
  meshes?: Array<{ primitives?: Array<{ attributes?: { POSITION?: unknown } }> }>;
  accessors?: GltfAccessor[];
}

const IDENTITY: Matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** Integer component types whose normalized value is `raw / maxMagnitude` (clamped to -1 for signed types). */
const NORMALIZED_SCALE: Record<number, { scale: number; signed: boolean }> = {
  5120: { scale: 127, signed: true },
  5121: { scale: 255, signed: false },
  5122: { scale: 32767, signed: true },
  5123: { scale: 65535, signed: false },
};

function multiply(a: Matrix, b: Matrix): Matrix {
  const out = new Array<number>(16).fill(0);
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row]! * b[column * 4 + k]!;
      out[column * 4 + row] = sum;
    }
  }
  return out;
}

function numberArray(value: unknown, length: number): number[] | undefined {
  if (!Array.isArray(value) || value.length !== length) return undefined;
  return value.every((item) => typeof item === "number" && Number.isFinite(item)) ? (value as number[]) : undefined;
}

function nodeMatrix(node: GltfNode): Matrix | undefined {
  if (node.matrix !== undefined) return numberArray(node.matrix, 16);
  const translation = node.translation === undefined ? [0, 0, 0] : numberArray(node.translation, 3);
  const rotation = node.rotation === undefined ? [0, 0, 0, 1] : numberArray(node.rotation, 4);
  const scale = node.scale === undefined ? [1, 1, 1] : numberArray(node.scale, 3);
  if (!translation || !rotation || !scale) return undefined;
  const [x, y, z, w] = rotation as [number, number, number, number];
  const length = Math.hypot(x, y, z, w);
  if (length === 0) return undefined;
  const [qx, qy, qz, qw] = [x / length, y / length, z / length, w / length] as [number, number, number, number];
  const [sx, sy, sz] = scale as [number, number, number];
  return [
    (1 - 2 * (qy * qy + qz * qz)) * sx, 2 * (qx * qy + qz * qw) * sx, 2 * (qx * qz - qy * qw) * sx, 0,
    2 * (qx * qy - qz * qw) * sy, (1 - 2 * (qx * qx + qz * qz)) * sy, 2 * (qy * qz + qx * qw) * sy, 0,
    2 * (qx * qz + qy * qw) * sz, 2 * (qy * qz - qx * qw) * sz, (1 - 2 * (qx * qx + qy * qy)) * sz, 0,
    translation[0]!, translation[1]!, translation[2]!, 1,
  ];
}

function readJsonChunk(bytes: Uint8Array): GltfDocument | undefined {
  if (bytes.byteLength < 20) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (start + length > bytes.byteLength) return undefined;
    if (type === JSON_CHUNK) {
      const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes.subarray(start, start + length)));
      return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as GltfDocument) : undefined;
    }
    offset = start + length + ((4 - (length % 4)) % 4);
  }
  return undefined;
}

/** POSITION accessor box in the accessor's own (possibly normalized-integer) units. */
function accessorBox(accessor: GltfAccessor | undefined): { min: number[]; max: number[] } | undefined {
  if (!accessor || accessor.type !== "VEC3") return undefined;
  const min = numberArray(accessor.min, 3);
  const max = numberArray(accessor.max, 3);
  if (!min || !max) return undefined;
  if (accessor.normalized === true) {
    const rule = typeof accessor.componentType === "number" ? NORMALIZED_SCALE[accessor.componentType] : undefined;
    if (!rule) return undefined;
    const normalize = (value: number) => (rule.signed ? Math.max(value / rule.scale, -1) : value / rule.scale);
    return { min: min.map(normalize), max: max.map(normalize) };
  }
  return { min, max };
}

/**
 * True when the GLB's JSON chunk declares at least one mesh. A file without meshes (animation-only clips,
 * empty node trees) has no bounding box to measure, which is not an import problem. Never throws.
 */
export function glbDeclaresMeshes(bytes: Uint8Array): boolean {
  try {
    const meshes = readJsonChunk(bytes)?.meshes;
    return Array.isArray(meshes) && meshes.length > 0;
  } catch {
    return false;
  }
}

/**
 * Size of the world-space bounding box of every scene, or undefined when the JSON is unreadable, has no
 * measurable POSITION accessor, or yields non-finite values. Never throws.
 */
export function measureGlbBoundsFromJson(bytes: Uint8Array): [number, number, number] | undefined {
  try {
    const document = readJsonChunk(bytes);
    if (!document || !Array.isArray(document.scenes) || !Array.isArray(document.nodes)) return undefined;
    const nodes = document.nodes;
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];

    const include = (accessorIndex: unknown, world: Matrix): void => {
      const box = typeof accessorIndex === "number" ? accessorBox(document.accessors?.[accessorIndex]) : undefined;
      if (!box) return;
      for (let corner = 0; corner < 8; corner++) {
        const point = [
          corner & 1 ? box.max[0]! : box.min[0]!,
          corner & 2 ? box.max[1]! : box.min[1]!,
          corner & 4 ? box.max[2]! : box.min[2]!,
        ];
        for (let axis = 0; axis < 3; axis++) {
          const value =
            world[axis]! * point[0]! + world[4 + axis]! * point[1]! + world[8 + axis]! * point[2]! + world[12 + axis]!;
          min[axis] = Math.min(min[axis]!, value);
          max[axis] = Math.max(max[axis]!, value);
        }
      }
    };

    const visitBudget = Math.max(nodes.length, 1) * Math.max(MAX_VISITS_PER_NODE, document.scenes.length);
    let visits = 0;
    const onPath = new Set<number>();
    const visit = (index: unknown, parent: Matrix, depth: number): void => {
      if (depth > MAX_NODE_DEPTH) throw new Error("node hierarchy too deep");
      const node = typeof index === "number" ? nodes[index] : undefined;
      if (!node || typeof node !== "object") return;
      const nodeIndex = index as number;
      if (onPath.has(nodeIndex)) throw new Error("cyclic node hierarchy");
      if (++visits > visitBudget) throw new Error("node graph is not a tree");
      const local = nodeMatrix(node);
      if (!local) throw new Error("invalid node transform");
      const world = multiply(parent, local);
      const mesh = typeof node.mesh === "number" ? document.meshes?.[node.mesh] : undefined;
      for (const primitive of mesh?.primitives ?? []) include(primitive.attributes?.POSITION, world);
      if (Array.isArray(node.children)) {
        onPath.add(nodeIndex);
        for (const child of node.children) visit(child, world, depth + 1);
        onPath.delete(nodeIndex);
      }
    };

    for (const scene of document.scenes) {
      if (Array.isArray(scene?.nodes)) for (const root of scene.nodes) visit(root, IDENTITY, 0);
    }
    const size = [0, 1, 2].map((axis) => max[axis]! - min[axis]!);
    if (!size.every((value) => Number.isFinite(value) && value >= 0)) return undefined;
    return [size[0]!, size[1]!, size[2]!];
  } catch {
    return undefined;
  }
}
