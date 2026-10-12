/**
 * Edge cases of the clip-level root-motion helpers: root-bone discovery, mode "none",
 * the in-place strip per mode, the sample-based extractRootMotion, and the inspector's
 * no-translation-track report. These were previously only reached indirectly.
 */
import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import {
  extractRootMotion,
  extractRootMotionFromClip,
  findRootBoneName,
  inspectClipRootMotion,
  sampleRootMotionAt,
  stripVisualRootDisplacement,
  type RootMotionSample,
} from "../src/index.js";

function posTrack(bone: string, times: number[], values: number[]): THREE.VectorKeyframeTrack {
  return new THREE.VectorKeyframeTrack(`${bone}.position`, times, values);
}

function clipWith(name: string, tracks: THREE.KeyframeTrack[], duration = 1): THREE.AnimationClip {
  return new THREE.AnimationClip(name, duration, tracks);
}

const WALK = [0, 0.5, 1];
const WALK_VALUES = [0, 1, 0, 0.25, 1.5, 1, 0.5, 2, 2];

test("findRootBoneName honours an existing preferred name over the default candidates", () => {
  const clip = clipWith("c", [posTrack("Hips", [0], [0, 0, 0]), posTrack("Spine", [0], [0, 0, 0])]);
  assert.equal(findRootBoneName(clip, "Spine"), "Spine");
});

test("findRootBoneName ignores a preferred name with no track and falls back to the defaults", () => {
  const clip = clipWith("c", [posTrack("Hips", [0], [0, 0, 0])]);
  assert.equal(findRootBoneName(clip, "Nope"), "Hips");
  // A bone that merely shares a prefix is not a match: the dot separates the bone from the property.
  const prefixOnly = clipWith("c", [posTrack("HipsExtra", [0], [0, 0, 0])]);
  assert.equal(findRootBoneName(prefixOnly, "Hips"), "HipsExtra");
});

test("findRootBoneName falls back to the first <bone>.position track, else undefined", () => {
  const custom = clipWith("c", [
    new THREE.QuaternionKeyframeTrack("Torso.quaternion", [0], [0, 0, 0, 1]),
    posTrack("Torso", [0], [0, 0, 0]),
    posTrack("Other", [0], [0, 0, 0]),
  ]);
  assert.equal(findRootBoneName(custom), "Torso");
  const onlyRotation = clipWith("c", [new THREE.QuaternionKeyframeTrack("Torso.quaternion", [0], [0, 0, 0, 1])]);
  assert.equal(findRootBoneName(onlyRotation), undefined);
  assert.equal(findRootBoneName(clipWith("empty", [])), undefined);
});

test("extractRootMotionFromClip mode none returns an untouched clone with empty samples", () => {
  const clip = clipWith("walk", [posTrack("Hips", WALK, WALK_VALUES)]);
  const result = extractRootMotionFromClip(clip, { mode: "none" });
  assert.equal(result.success, true);
  const extracted = result.extracted;
  assert.ok(extracted);
  assert.equal(extracted.mode, "none");
  assert.equal(extracted.rootBoneName, "none");
  assert.deepEqual(extracted.samples, []);
  assert.deepEqual(extracted.totalDisplacement, [0, 0, 0]);
  assert.equal(extracted.totalYaw, 0);
  assert.notEqual(extracted.inPlaceClip, clip, "the in-place clip must be a clone, not the input");
  assert.deepEqual([...(extracted.inPlaceClip.tracks[0]?.values ?? [])], WALK_VALUES);

  const named = extractRootMotionFromClip(clip, { mode: "none", rootBoneName: "Hips" });
  assert.equal(named.extracted?.rootBoneName, "Hips");
});

test("extractRootMotionFromClip reports invalidRoot when no root bone can be found", () => {
  const clip = clipWith("rotOnly", [new THREE.QuaternionKeyframeTrack("Torso.quaternion", [0], [0, 0, 0, 1])]);
  const result = extractRootMotionFromClip(clip, { mode: "extract-xz" });
  assert.equal(result.success, false);
  assert.equal(result.diagnostics?.code, "animation.rootMotion.invalidRoot");
  assert.match(result.error ?? "", /rotOnly/);
});

test("extractRootMotionFromClip reports trackMissing for an explicit root bone without a position track", () => {
  const clip = clipWith("walk", [posTrack("Hips", WALK, WALK_VALUES)]);
  const result = extractRootMotionFromClip(clip, { mode: "extract-xz", rootBoneName: "Ghost" });
  assert.equal(result.success, false);
  assert.equal(result.diagnostics?.code, "animation.rootMotion.trackMissing");
  assert.match(result.error ?? "", /Ghost\.position/);
});

test("extractRootMotionFromClip rejects non-monotonic position key times", () => {
  // THREE keeps the times it is given; a clip loaded from a corrupt file can be unsorted.
  const clip = clipWith("bad", [posTrack("Hips", [0, 0.6, 0.4], [0, 0, 0, 1, 0, 0, 2, 0, 0])]);
  const result = extractRootMotionFromClip(clip, { mode: "extract-xz" });
  assert.equal(result.success, false);
  assert.equal(result.diagnostics?.code, "animation.rootMotion.malformedSamples");
  assert.match(result.error ?? "", /index 2/);
});

test("stripVisualRootDisplacement locks X/Z per mode and keeps Y bobbing except for extract-xyz", () => {
  const clip = clipWith("walk", [
    posTrack("Hips", WALK, WALK_VALUES),
    posTrack("Spine", WALK, WALK_VALUES),
  ]);

  const xz = stripVisualRootDisplacement(clip, "Hips", "extract-xz");
  assert.deepEqual([...(xz.tracks[0]?.values ?? [])], [0, 1, 0, 0, 1.5, 0, 0, 2, 0]);
  // A non-root track is passed through unchanged.
  assert.deepEqual([...(xz.tracks[1]?.values ?? [])], WALK_VALUES);

  const xyz = stripVisualRootDisplacement(clip, "Hips", "extract-xyz");
  assert.deepEqual([...(xyz.tracks[0]?.values ?? [])], [0, 1, 0, 0, 1, 0, 0, 1, 0]);

  const none = stripVisualRootDisplacement(clip, "Hips", "none");
  assert.notEqual(none, clip);
  assert.deepEqual([...(none.tracks[0]?.values ?? [])], WALK_VALUES);

  // The input clip is never mutated.
  assert.deepEqual([...(clip.tracks[0]?.values ?? [])], WALK_VALUES);
});

test("stripVisualRootDisplacement extract-xz-yaw removes the twist about Y but keeps the swing", () => {
  const yaw = Math.PI / 2;
  const twist = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  const tilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.3);
  // The decomposition treats q as swing * twist, so build it in that order.
  const turnedAndTilted = tilt.clone().multiply(twist);
  const clip = clipWith("turn", [
    posTrack("Hips", [0, 1], [0, 0, 0, 1, 0, 1]),
    new THREE.QuaternionKeyframeTrack(
      "Hips.quaternion",
      [0, 1],
      [0, 0, 0, 1, turnedAndTilted.x, turnedAndTilted.y, turnedAndTilted.z, turnedAndTilted.w],
    ),
  ]);
  const stripped = stripVisualRootDisplacement(clip, "Hips", "extract-xz-yaw");
  const rot = stripped.tracks.find((t) => t.name === "Hips.quaternion");
  assert.ok(rot instanceof THREE.QuaternionKeyframeTrack);
  const last = new THREE.Quaternion(rot.values[4], rot.values[5], rot.values[6], rot.values[7]);
  // Remaining rotation has no Y twist: it is a pure rotation about X.
  assert.ok(Math.abs(last.y) < 1e-5, `expected no Y twist, got y=${last.y}`);
  assert.ok(Math.abs(last.length() - 1) < 1e-5, "stays a unit quaternion");
  assert.ok(
    Math.abs(last.x - tilt.x) < 1e-5 && Math.abs(last.w - tilt.w) < 1e-5,
    "the tilt (swing) is preserved",
  );

  // extract-xz leaves the rotation track alone (cloned, values identical).
  const keepRot = stripVisualRootDisplacement(clip, "Hips", "extract-xz");
  const keep = keepRot.tracks.find((t) => t.name === "Hips.quaternion");
  assert.deepEqual([...(keep?.values ?? [])], [...(clip.tracks[1]?.values ?? [])]);
});

test("extractRootMotionFromClip totals match the key positions for extract-xyz", () => {
  const clip = clipWith("walk", [posTrack("Hips", WALK, WALK_VALUES)]);
  const result = extractRootMotionFromClip(clip, { mode: "extract-xyz" });
  assert.equal(result.success, true);
  const extracted = result.extracted;
  assert.ok(extracted);
  assert.equal(extracted.rootBoneName, "Hips");
  assert.deepEqual(extracted.totalDisplacement, [0.5, 1, 2]);
  assert.equal(extracted.totalYaw, 0, "no rotation track means zero yaw");
  assert.deepEqual(
    extracted.samples.map((s) => s.time),
    WALK,
  );
});

test("extractRootMotion (sample based) in extract-xyz locks every axis of the in-place samples", () => {
  const samples: RootMotionSample[] = [
    { time: 0, position: [1, 2, 3], yaw: 0.5 },
    { time: 1, position: [2, 4, 7], yaw: 0.9 },
  ];
  const result = extractRootMotion(samples, "extract-xyz");
  assert.deepEqual(result.deltas, [{ time: 1, translation: [1, 2, 4], yaw: 0 }]);
  assert.deepEqual(result.inPlace[1]?.position, [1, 2, 3]);
  assert.equal(result.inPlace[1]?.yaw, 0.9, "yaw is only locked by extract-xz-yaw");
  // The input samples are not mutated.
  assert.deepEqual(samples[1]?.position, [2, 4, 7]);

  const withYaw = extractRootMotion(samples, "extract-xz-yaw");
  assert.deepEqual(withYaw.inPlace[1]?.yaw, 0.5);
  assert.ok(Math.abs((withYaw.deltas[0]?.yaw ?? 0) - 0.4) < 1e-12);
  assert.deepEqual(withYaw.inPlace[1]?.position[1], 4, "extract-xz-yaw keeps Y");

  assert.deepEqual(extractRootMotion([], "extract-xz"), { mode: "extract-xz", deltas: [], inPlace: [] });
  const none = extractRootMotion(samples, "none");
  assert.deepEqual(none.deltas[0]?.translation, [0, 0, 0]);
  assert.deepEqual(none.inPlace[1]?.position, [2, 4, 7]);
});

test("sampleRootMotionAt of no samples is the origin", () => {
  assert.deepEqual(sampleRootMotionAt([], 0.5, 1), { position: [0, 0, 0], yaw: 0 });
});

test("inspectClipRootMotion reports in-place with zeros when the root has no translation track", () => {
  const clip = clipWith("rotOnly", [new THREE.QuaternionKeyframeTrack("Hips.quaternion", [0], [0, 0, 0, 1])], 2);
  const report = inspectClipRootMotion(clip, "Hips");
  assert.equal(report.sampleCount, 0);
  assert.equal(report.isLocomotion, false);
  assert.equal(report.classification, "in-place");
  assert.deepEqual(report.netDisplacement, [0, 0, 0]);
  assert.equal(report.duration, 2);
  assert.match(report.reason, /No translation track found for designated root bone "Hips"/);

  const unknown = inspectClipRootMotion(clipWith("empty", []));
  assert.equal(unknown.rootBoneName, "unknown");
  assert.equal(unknown.sampleCount, 0);
});

test("inspectClipRootMotion classifies by net travel (>0.1 m) or max deviation (>0.5 m)", () => {
  const net = inspectClipRootMotion(clipWith("net", [posTrack("Hips", [0, 1], [0, 0, 0, 0, 0, 0.2])]));
  assert.equal(net.classification, "locomotion");
  const small = inspectClipRootMotion(clipWith("small", [posTrack("Hips", [0, 1], [0, 0, 0, 0, 0, 0.05])]));
  assert.equal(small.classification, "in-place");
  // Out and back: zero net travel but a 0.6 m excursion still counts as locomotion.
  const loop = inspectClipRootMotion(
    clipWith("loop", [posTrack("Hips", [0, 0.5, 1], [0, 0, 0, 0, 0, 0.6, 0, 0, 0])]),
  );
  assert.equal(loop.netDisplacement[2], 0);
  assert.ok(Math.abs(loop.maxDisplacementXZ - 0.6) < 1e-6);
  assert.equal(loop.classification, "locomotion");
});
