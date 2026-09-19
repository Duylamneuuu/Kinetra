import { Document, NodeIO } from "@gltf-transform/core";

export interface SyntheticGlbOptions {
  meshName?: string;
  nodeName?: string;
  materialName?: string;
  size?: [number, number, number];
  color?: [number, number, number, number];
}

/**
 * Creates a deterministic, valid glTF 2.0 binary (GLB) in-memory.
 * Contains one node, one mesh, one material, with a unit box geometry centered at origin.
 */
export async function createSyntheticGlb(
  options: SyntheticGlbOptions = {},
): Promise<Uint8Array> {
  const meshName = options.meshName ?? "TestBoxMesh";
  const nodeName = options.nodeName ?? "TestBoxNode";
  const materialName = options.materialName ?? "TestBoxMaterial";
  const size = options.size ?? [1, 1, 1];
  const color = options.color ?? [0.0, 0.7, 0.85, 1.0];

  const halfX = size[0] / 2;
  const halfY = size[1] / 2;
  const halfZ = size[2] / 2;

  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene("Scene");

  // 8 vertices of a box centered at [0, 0, 0]
  const positions = new Float32Array([
    -halfX, -halfY,  halfZ,
     halfX, -halfY,  halfZ,
     halfX,  halfY,  halfZ,
    -halfX,  halfY,  halfZ,
    -halfX, -halfY, -halfZ,
     halfX, -halfY, -halfZ,
     halfX,  halfY, -halfZ,
    -halfX,  halfY, -halfZ,
  ]);

  // 12 triangles (36 indices), CCW outward normals
  const indices = new Uint16Array([
    // front (+Z)
    0, 1, 2,  0, 2, 3,
    // right (+X)
    1, 5, 6,  1, 6, 2,
    // back (-Z)
    5, 4, 7,  5, 7, 6,
    // left (-X)
    4, 0, 3,  4, 3, 7,
    // top (+Y)
    3, 2, 6,  3, 6, 7,
    // bottom (-Y)
    4, 5, 1,  4, 1, 0,
  ]);

  const positionAccessor = doc
    .createAccessor("positions")
    .setType("VEC3")
    .setArray(positions)
    .setBuffer(buffer);

  const indicesAccessor = doc
    .createAccessor("indices")
    .setType("SCALAR")
    .setArray(indices)
    .setBuffer(buffer);

  const material = doc
    .createMaterial(materialName)
    .setBaseColorFactor(color)
    .setRoughnessFactor(0.4)
    .setMetallicFactor(0.1);

  const primitive = doc
    .createPrimitive()
    .setAttribute("POSITION", positionAccessor)
    .setIndices(indicesAccessor)
    .setMaterial(material);

  const mesh = doc.createMesh(meshName).addPrimitive(primitive);
  const node = doc.createNode(nodeName).setMesh(mesh);

  scene.addChild(node);

  const io = new NodeIO();
  return io.writeBinary(doc);
}
