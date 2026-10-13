import assert from "node:assert/strict";
import test from "node:test";
import { Document, NodeIO } from "@gltf-transform/core";
import { inspectSkeletonFromGlb } from "../src/index.js";

// inspectSkeletonFromGlb reads user GLBs without a DOM; these cases cover the shapes the happy path
// skips: no skin at all, unnamed joints/skins/animations, parent lookup and clip duration.
async function glb(build: (doc: Document) => void): Promise<Uint8Array> {
  const doc = new Document();
  doc.createBuffer();
  build(doc);
  return new NodeIO().writeBinary(doc);
}

test("a GLB without a skin yields a not-found warning and empty bones", async () => {
  const bytes = await glb((doc) => {
    const node = doc.createNode("Prop");
    doc.createScene("s").addChild(node);
  });
  const result = await inspectSkeletonFromGlb(bytes);
  assert.equal(result.skinName, undefined);
  assert.deepEqual(result.bones, []);
  assert.deepEqual(result.clips, []);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0]!.code, "retarget.skin.not-found");
  assert.equal(result.diagnostics[0]!.severity, "warning");
});

test("an ArrayBuffer input is accepted like a Uint8Array", async () => {
  const bytes = await glb((doc) => {
    doc.createScene("s").addChild(doc.createNode("Prop"));
  });
  const copy = bytes.slice().buffer;
  const result = await inspectSkeletonFromGlb(copy);
  assert.equal(result.diagnostics[0]!.code, "retarget.skin.not-found");
});

test("skin, joint parents, unnamed joint fallback and clip duration are reported", async () => {
  const bytes = await glb((doc) => {
    const hips = doc.createNode("Hips").setTranslation([0, 1, 0]);
    const spine = doc.createNode("Spine").setScale([2, 2, 2]);
    const unnamed = doc.createNode("");
    hips.addChild(spine);
    spine.addChild(unnamed);
    doc.createScene("s").addChild(hips);
    doc.createSkin("").addJoint(hips).addJoint(spine).addJoint(unnamed);

    const buffer = doc.getRoot().listBuffers()[0]!;
    const times = doc
      .createAccessor("times")
      .setType("SCALAR")
      .setArray(new Float32Array([0, 0.5, 2]))
      .setBuffer(buffer);
    const values = doc
      .createAccessor("values")
      .setType("VEC3")
      .setArray(new Float32Array([0, 0, 0, 0, 1, 0, 0, 2, 0]))
      .setBuffer(buffer);
    const sampler = doc.createAnimationSampler().setInput(times).setOutput(values);
    const channel = doc
      .createAnimationChannel()
      .setTargetNode(hips)
      .setTargetPath("translation")
      .setSampler(sampler);
    doc.createAnimation("").addSampler(sampler).addChannel(channel);
  });

  const result = await inspectSkeletonFromGlb(bytes);
  assert.equal(result.skinName, "Armature");
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(
    result.bones.map((b) => b.name),
    ["Hips", "Spine", "Joint_2"],
  );
  assert.equal(result.bones[0]!.parent, undefined);
  assert.equal(result.bones[1]!.parent, "Hips");
  // The unnamed joint is looked up under its fallback name, which no node carries.
  assert.equal(result.bones[2]!.parent, undefined);
  assert.deepEqual(result.bones[0]!.restTranslation, [0, 1, 0]);
  assert.deepEqual(result.bones[1]!.restScale, [2, 2, 2]);
  assert.deepEqual(result.bones[1]!.restRotation, [0, 0, 0, 1]);

  assert.equal(result.clips.length, 1);
  assert.equal(result.clips[0]!.name, "anim_0");
  assert.equal(result.clips[0]!.duration, 2);
  assert.equal(result.clips[0]!.channelCount, 1);
  assert.deepEqual(result.clips[0]!.targetNodes, ["Hips"]);
});

test("an animation with no channels reports zero duration and no targets", async () => {
  const bytes = await glb((doc) => {
    const joint = doc.createNode("Hips");
    doc.createScene("s").addChild(joint);
    doc.createSkin("Rig").addJoint(joint);
    doc.createAnimation("Idle");
  });
  const result = await inspectSkeletonFromGlb(bytes);
  assert.equal(result.skinName, "Rig");
  assert.deepEqual(result.clips, [{ name: "Idle", duration: 0, channelCount: 0, targetNodes: [] }]);
});

test("garbage bytes reject instead of returning a partial result", async () => {
  await assert.rejects(() => inspectSkeletonFromGlb(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])));
});
