import { Document, NodeIO } from "@gltf-transform/core";

export interface SyntheticGlbAnimationOptions {
  clipName?: string;
  duration?: number;
  property?: "translation" | "rotation" | "scale";
  from?: [number, number, number];
  to?: [number, number, number];
}

export interface SyntheticGlbOptions {
  meshName?: string;
  nodeName?: string;
  materialName?: string;
  size?: [number, number, number];
  color?: [number, number, number, number];
  animation?: SyntheticGlbAnimationOptions;
}

function createBoxMesh(
  doc: Document,
  buffer: import("@gltf-transform/core").Buffer,
  meshName: string,
  size: [number, number, number],
  material: import("@gltf-transform/core").Material,
): import("@gltf-transform/core").Mesh {
  const halfX = size[0] / 2;
  const halfY = size[1] / 2;
  const halfZ = size[2] / 2;

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

  const indices = new Uint16Array([
    0, 1, 2,  0, 2, 3,
    1, 5, 6,  1, 6, 2,
    5, 4, 7,  5, 7, 6,
    4, 0, 3,  4, 3, 7,
    3, 2, 6,  3, 6, 7,
    4, 5, 1,  4, 1, 0,
  ]);

  const positionAccessor = doc
    .createAccessor(`${meshName}_positions`)
    .setType("VEC3")
    .setArray(positions)
    .setBuffer(buffer);

  const indicesAccessor = doc
    .createAccessor(`${meshName}_indices`)
    .setType("SCALAR")
    .setArray(indices)
    .setBuffer(buffer);

  const primitive = doc
    .createPrimitive()
    .setAttribute("POSITION", positionAccessor)
    .setIndices(indicesAccessor)
    .setMaterial(material);

  return doc.createMesh(meshName).addPrimitive(primitive);
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

  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene("Scene");

  const material = doc
    .createMaterial(materialName)
    .setBaseColorFactor(color)
    .setRoughnessFactor(0.4)
    .setMetallicFactor(0.1);

  const mesh = createBoxMesh(doc, buffer, meshName, size, material);
  const node = doc.createNode(nodeName).setMesh(mesh);

  scene.addChild(node);

  if (options.animation) {
    const clipName = options.animation.clipName ?? "MoveX";
    const duration = options.animation.duration ?? 1.0;
    const property = options.animation.property ?? "translation";
    const from = options.animation.from ?? [0, 0, 0];
    const to = options.animation.to ?? [1, 0, 0];

    const inputAccessor = doc
      .createAccessor(`${clipName}_times`)
      .setType("SCALAR")
      .setArray(new Float32Array([0.0, duration]))
      .setBuffer(buffer);

    const outputAccessor = doc
      .createAccessor(`${clipName}_values`)
      .setType("VEC3")
      .setArray(new Float32Array([
        from[0], from[1], from[2],
        to[0], to[1], to[2],
      ]))
      .setBuffer(buffer);

    const sampler = doc
      .createAnimationSampler()
      .setInput(inputAccessor)
      .setOutput(outputAccessor)
      .setInterpolation("LINEAR");

    const channel = doc
      .createAnimationChannel()
      .setTargetPath(property)
      .setTargetNode(node)
      .setSampler(sampler);

    doc.createAnimation(clipName)
      .addSampler(sampler)
      .addChannel(channel);
  }

  const io = new NodeIO();
  return io.writeBinary(doc);
}

/**
 * Creates a deterministic, valid glTF 2.0 binary (GLB) with a named animation clip.
 * Default: "AnimatedBoxNode", "AnimatedBoxMesh", clip "MoveX" (1.0s, X translation 0 -> 1).
 */
export async function createSyntheticAnimatedGlb(
  options: {
    meshName?: string;
    nodeName?: string;
    materialName?: string;
    clipName?: string;
    duration?: number;
    from?: [number, number, number];
    to?: [number, number, number];
    size?: [number, number, number];
    color?: [number, number, number, number];
  } = {},
): Promise<Uint8Array> {
  return createSyntheticGlb({
    meshName: options.meshName ?? "AnimatedBoxMesh",
    nodeName: options.nodeName ?? "AnimatedBoxNode",
    materialName: options.materialName ?? "AnimatedBoxMaterial",
    ...(options.size !== undefined ? { size: options.size } : {}),
    ...(options.color !== undefined ? { color: options.color } : {}),
    animation: {
      clipName: options.clipName ?? "MoveX",
      duration: options.duration ?? 1.0,
      property: "translation",
      from: options.from ?? [0, 0, 0],
      to: options.to ?? [1, 0, 0],
    },
  });
}

export interface SyntheticPropGlbOptions {
  name?: string;
  frameSize?: [number, number, number];
  coreSize?: [number, number, number];
  frameColor?: [number, number, number, number];
  coreColor?: [number, number, number, number];
}

/**
 * Creates a deterministic, valid glTF 2.0 binary (GLB) for a stylized sci-fi energy crate prop.
 * Contains:
 * - Root node: "EnergyCrate_Root"
 *   - Child node 1: "EnergyCrate_Frame" (metallic frame mesh, default 0.8x0.8x0.8m)
 *   - Child node 2: "EnergyCrate_Core" (emissive power cell mesh, default 0.45x0.45x0.45m)
 * - 2 distinct meshes, 2 distinct PBR materials (metallic frame + emissive power core)
 */
export async function createSyntheticPropGlb(
  options: SyntheticPropGlbOptions = {},
): Promise<Uint8Array> {
  const name = options.name ?? "EnergyCrate";
  const frameSize = options.frameSize ?? [0.8, 0.8, 0.8];
  const coreSize = options.coreSize ?? [0.45, 0.45, 0.45];
  const frameColor = options.frameColor ?? [0.25, 0.3, 0.35, 1.0];
  const coreColor = options.coreColor ?? [0.0, 0.85, 1.0, 1.0];

  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene("Scene");

  const rootNode = doc.createNode(`${name}_Root`);
  scene.addChild(rootNode);

  // 1. Frame material and mesh
  const frameMaterial = doc
    .createMaterial(`${name}_FrameMaterial`)
    .setBaseColorFactor(frameColor)
    .setRoughnessFactor(0.3)
    .setMetallicFactor(0.85);

  const frameMesh = createBoxMesh(doc, buffer, `${name}_FrameMesh`, frameSize, frameMaterial);
  const frameNode = doc.createNode(`${name}_Frame`).setMesh(frameMesh);
  rootNode.addChild(frameNode);

  // 2. Core material and mesh
  const coreMaterial = doc
    .createMaterial(`${name}_CoreMaterial`)
    .setBaseColorFactor(coreColor)
    .setRoughnessFactor(0.2)
    .setMetallicFactor(0.1)
    .setEmissiveFactor([0.1, 0.7, 0.9]);

  const coreMesh = createBoxMesh(doc, buffer, `${name}_CoreMesh`, coreSize, coreMaterial);
  const coreNode = doc.createNode(`${name}_Core`).setMesh(coreMesh);
  rootNode.addChild(coreNode);

  const io = new NodeIO();
  return io.writeBinary(doc);
}

