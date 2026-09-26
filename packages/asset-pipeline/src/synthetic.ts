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

export interface SyntheticCharacterGlbOptions {
  name?: string;
  color?: [number, number, number, number];
}

/**
 * Creates a deterministic, valid glTF 2.0 binary (GLB) for a rigged/skinned biped character.
 * Contains:
 * - Skeleton joints: Hips, Spine, Head, LeftArm, RightArm, LeftLeg, RightLeg
 * - SkinnedMesh with vertex positions, normals, JOINTS_0, WEIGHTS_0, and inverseBindMatrices
 * - 6 distinct combat-gameplay animation clips:
 *   - "idle": subtle spine breathing
 *   - "walk": alternating leg/arm locomotion swing
 *   - "telegraph": windup stance with arm raised and torso coiled
 *   - "attack": forward thrust strike
 *   - "hurt": recoil flinch reaction
 *   - "defeat": collapse and drop to ground
 */
export async function createSyntheticCharacterGlb(
  options: SyntheticCharacterGlbOptions = {},
): Promise<Uint8Array> {
  const name = options.name ?? "EnemyBot";
  const color = options.color ?? [0.85, 0.25, 0.25, 1.0];

  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene("Scene");

  const root = doc.createNode(`${name}_Root`);
  scene.addChild(root);

  // Skeleton joint nodes (local transforms in rest pose)
  const hips = doc.createNode("Hips").setTranslation([0, 0.9, 0]);
  const spine = doc.createNode("Spine").setTranslation([0, 0.35, 0]);
  const head = doc.createNode("Head").setTranslation([0, 0.35, 0]);
  const leftArm = doc.createNode("LeftArm").setTranslation([-0.35, 0.25, 0]);
  const rightArm = doc.createNode("RightArm").setTranslation([0.35, 0.25, 0]);
  const leftLeg = doc.createNode("LeftLeg").setTranslation([-0.2, -0.4, 0]);
  const rightLeg = doc.createNode("RightLeg").setTranslation([0.2, -0.4, 0]);

  root.addChild(hips);
  hips.addChild(spine);
  hips.addChild(leftLeg);
  hips.addChild(rightLeg);
  spine.addChild(head);
  spine.addChild(leftArm);
  spine.addChild(rightArm);

  const joints = [hips, spine, head, leftArm, rightArm, leftLeg, rightLeg];
  const jointWorldPositions: [number, number, number][] = [
    [0, 0.9, 0],       // Hips (0)
    [0, 1.25, 0],      // Spine (1)
    [0, 1.6, 0],       // Head (2)
    [-0.35, 1.5, 0],   // LeftArm (3)
    [0.35, 1.5, 0],    // RightArm (4)
    [-0.2, 0.5, 0],    // LeftLeg (5)
    [0.2, 0.5, 0],     // RightLeg (6)
  ];

  // Inverse bind matrices in column-major order for translation-only rest joints
  const ibmArray = new Float32Array(joints.length * 16);
  for (let i = 0; i < joints.length; i++) {
    const [x, y, z] = jointWorldPositions[i]!;
    const offset = i * 16;
    ibmArray.set([
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      -x, -y, -z, 1,
    ], offset);
  }

  const ibmAccessor = doc
    .createAccessor(`${name}_ibm`)
    .setType("MAT4")
    .setArray(ibmArray)
    .setBuffer(buffer);

  const skin = doc.createSkin(`${name}_Skin`);
  for (const j of joints) {
    skin.addJoint(j);
  }
  skin.setSkeleton(hips);
  skin.setInverseBindMatrices(ibmAccessor);

  // Body box segments bound to specific joints
  const segments: Array<{
    jointIdx: number;
    size: [number, number, number];
    center: [number, number, number];
  }> = [
    { jointIdx: 0, size: [0.35, 0.2, 0.25], center: [0, 0.9, 0] },     // Pelvis / Hips
    { jointIdx: 1, size: [0.4, 0.3, 0.25], center: [0, 1.25, 0] },     // Torso / Spine
    { jointIdx: 2, size: [0.25, 0.25, 0.25], center: [0, 1.6, 0] },    // Head
    { jointIdx: 3, size: [0.15, 0.35, 0.15], center: [-0.35, 1.35, 0] }, // Left Arm
    { jointIdx: 4, size: [0.15, 0.35, 0.15], center: [0.35, 1.35, 0] },  // Right Arm
    { jointIdx: 5, size: [0.15, 0.45, 0.15], center: [-0.2, 0.25, 0] },  // Left Leg
    { jointIdx: 6, size: [0.15, 0.45, 0.15], center: [0.2, 0.25, 0] },   // Right Leg
  ];

  const allPositions: number[] = [];
  const allNormals: number[] = [];
  const allJoints: number[] = [];
  const allWeights: number[] = [];
  const allIndices: number[] = [];

  for (let s = 0; s < segments.length; s++) {
    const { jointIdx, size: [sx, sy, sz], center: [cx, cy, cz] } = segments[s]!;
    const hx = sx / 2;
    const hy = sy / 2;
    const hz = sz / 2;
    const baseV = allPositions.length / 3;

    // 8 vertices per segment box
    const v = [
      cx - hx, cy - hy, cz + hz,
      cx + hx, cy - hy, cz + hz,
      cx + hx, cy + hy, cz + hz,
      cx - hx, cy + hy, cz + hz,
      cx - hx, cy - hy, cz - hz,
      cx + hx, cy - hy, cz - hz,
      cx + hx, cy + hy, cz - hz,
      cx - hx, cy + hy, cz - hz,
    ];
    allPositions.push(...v);

    for (let k = 0; k < 8; k++) {
      allNormals.push(0, 1, 0);
      allJoints.push(jointIdx, 0, 0, 0);
      allWeights.push(1.0, 0.0, 0.0, 0.0);
    }

    const ind = [
      0, 1, 2,  0, 2, 3, // front
      1, 5, 6,  1, 6, 2, // right
      5, 4, 7,  5, 7, 6, // back
      4, 0, 3,  4, 3, 7, // left
      3, 2, 6,  3, 6, 7, // top
      4, 5, 1,  4, 1, 0, // bottom
    ];
    for (const idx of ind) {
      allIndices.push(baseV + idx);
    }
  }

  const posAcc = doc
    .createAccessor(`${name}_positions`)
    .setType("VEC3")
    .setArray(new Float32Array(allPositions))
    .setBuffer(buffer);

  const normAcc = doc
    .createAccessor(`${name}_normals`)
    .setType("VEC3")
    .setArray(new Float32Array(allNormals))
    .setBuffer(buffer);

  const jointsAcc = doc
    .createAccessor(`${name}_joints`)
    .setType("VEC4")
    .setArray(new Uint8Array(allJoints))
    .setBuffer(buffer);

  const weightsAcc = doc
    .createAccessor(`${name}_weights`)
    .setType("VEC4")
    .setArray(new Float32Array(allWeights))
    .setBuffer(buffer);

  const indAcc = doc
    .createAccessor(`${name}_indices`)
    .setType("SCALAR")
    .setArray(new Uint16Array(allIndices))
    .setBuffer(buffer);

  const material = doc
    .createMaterial(`${name}_Material`)
    .setBaseColorFactor(color)
    .setRoughnessFactor(0.35)
    .setMetallicFactor(0.8);

  const prim = doc
    .createPrimitive()
    .setAttribute("POSITION", posAcc)
    .setAttribute("NORMAL", normAcc)
    .setAttribute("JOINTS_0", jointsAcc)
    .setAttribute("WEIGHTS_0", weightsAcc)
    .setIndices(indAcc)
    .setMaterial(material);

  const mesh = doc.createMesh(`${name}_Mesh`).addPrimitive(prim);
  const meshNode = doc.createNode(`${name}_SkinnedNode`).setMesh(mesh).setSkin(skin);
  root.addChild(meshNode);

  function addChannel(
    anim: import("@gltf-transform/core").Animation,
    targetNode: import("@gltf-transform/core").Node,
    path: "translation" | "rotation" | "scale",
    times: number[],
    values: number[],
    type: "VEC3" | "VEC4" = "VEC4",
  ): void {
    const timeAcc = doc
      .createAccessor()
      .setType("SCALAR")
      .setArray(new Float32Array(times))
      .setBuffer(buffer);
    const valAcc = doc
      .createAccessor()
      .setType(type)
      .setArray(new Float32Array(values))
      .setBuffer(buffer);
    const sampler = doc
      .createAnimationSampler()
      .setInput(timeAcc)
      .setOutput(valAcc)
      .setInterpolation("LINEAR");
    const channel = doc
      .createAnimationChannel()
      .setTargetPath(path)
      .setTargetNode(targetNode)
      .setSampler(sampler);
    anim.addSampler(sampler).addChannel(channel);
  }

  // 1. Idle (1.0s): subtle spine breathing oscillation
  const idleAnim = doc.createAnimation("idle");
  addChannel(
    idleAnim,
    spine,
    "rotation",
    [0, 0.5, 1.0],
    [0, 0, 0, 1,  0.03, 0, 0, 0.999,  0, 0, 0, 1],
  );

  // 2. Walk (1.0s): alternating legs and arms swing
  const walkAnim = doc.createAnimation("walk");
  addChannel(
    walkAnim,
    leftLeg,
    "rotation",
    [0, 0.5, 1.0],
    [-0.26, 0, 0, 0.965,  0.26, 0, 0, 0.965,  -0.26, 0, 0, 0.965],
  );
  addChannel(
    walkAnim,
    rightLeg,
    "rotation",
    [0, 0.5, 1.0],
    [0.26, 0, 0, 0.965,  -0.26, 0, 0, 0.965,  0.26, 0, 0, 0.965],
  );
  addChannel(
    walkAnim,
    leftArm,
    "rotation",
    [0, 0.5, 1.0],
    [0.2, 0, 0, 0.98,  -0.2, 0, 0, 0.98,  0.2, 0, 0, 0.98],
  );
  addChannel(
    walkAnim,
    rightArm,
    "rotation",
    [0, 0.5, 1.0],
    [-0.2, 0, 0, 0.98,  0.2, 0, 0, 0.98,  -0.2, 0, 0, 0.98],
  );

  // 3. Telegraph (0.6s): coil back and raise arm into warning stance
  const teleAnim = doc.createAnimation("telegraph");
  addChannel(
    teleAnim,
    spine,
    "rotation",
    [0, 0.6],
    [0, 0, 0, 1,  -0.15, 0, 0, 0.989],
  );
  addChannel(
    teleAnim,
    rightArm,
    "rotation",
    [0, 0.6],
    [0, 0, 0, 1,  0.6, 0, 0, 0.8],
  );

  // 4. Attack (0.4s): forward thrust strike
  const atkAnim = doc.createAnimation("attack");
  addChannel(
    atkAnim,
    rightArm,
    "rotation",
    [0, 0.2, 0.4],
    [0.6, 0, 0, 0.8,  -0.7, 0, 0, 0.714,  0, 0, 0, 1],
  );
  addChannel(
    atkAnim,
    spine,
    "rotation",
    [0, 0.2, 0.4],
    [-0.15, 0, 0, 0.989,  0.2, 0, 0, 0.98,  0, 0, 0, 1],
  );

  // 5. Hurt (0.3s): recoil flinch
  const hurtAnim = doc.createAnimation("hurt");
  addChannel(
    hurtAnim,
    spine,
    "rotation",
    [0, 0.15, 0.3],
    [0, 0, 0, 1,  -0.3, 0, 0, 0.954,  0, 0, 0, 1],
  );

  // 6. Defeat (1.0s): hips drop, spine collapses
  const defAnim = doc.createAnimation("defeat");
  addChannel(
    defAnim,
    hips,
    "translation",
    [0, 0.5, 1.0],
    [0, 0.9, 0,  0, 0.4, 0,  0, 0.15, 0],
    "VEC3",
  );
  addChannel(
    defAnim,
    spine,
    "rotation",
    [0, 0.5, 1.0],
    [0, 0, 0, 1,  0.4, 0, 0, 0.916,  0.6, 0, 0, 0.8],
  );

  const io = new NodeIO();
  return io.writeBinary(doc);
}


