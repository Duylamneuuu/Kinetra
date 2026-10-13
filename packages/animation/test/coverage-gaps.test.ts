import assert from "node:assert/strict";
import test from "node:test";

import { Document, NodeIO } from "@gltf-transform/core";
import * as THREE from "three";

import {
  AnimationGraphMachine,
  bakeRetargetedClip,
  inspectSkeletonFromGlb,
  validateClipMetadata,
  validateSkeletonProfile,
  type AnimationClipMetadata,
  type AnimationGraphDefinition,
  type SkeletonProfile,
} from "../src/index.js";

// Regression tests for branches the unit-test coverage report showed as never executed:
// clip event validation, duplicate skeleton targets, AnimationGraphMachine.reset(entryState),
// the "no skin" GLB diagnostic and the invalid retarget track name diagnostic.

function clip(overrides: Partial<AnimationClipMetadata> = {}): AnimationClipMetadata {
  return {
    id: "walk",
    name: "Walk",
    duration: 2,
    sourceAssetId: "asset:walk",
    events: [],
    ...overrides,
  };
}

test("validateClipMetadata accepts events at the clip boundaries", () => {
  assert.deepEqual(
    validateClipMetadata(clip({ events: [{ time: 0, name: "start" }, { time: 2, name: "end" }] })),
    [],
  );
});

test("validateClipMetadata flags events outside the clip duration", () => {
  const issues = validateClipMetadata(
    clip({ events: [{ time: -0.1, name: "early" }, { time: 2.5, name: "late" }] }),
  );
  assert.ok(issues.includes('event "early" is outside clip duration'));
  assert.ok(issues.includes('event "late" is outside clip duration'));
});

test("validateClipMetadata flags unsorted events once and stops scanning", () => {
  const issues = validateClipMetadata(
    clip({
      events: [
        { time: 1.5, name: "b" },
        { time: 0.5, name: "a" },
        { time: 0.25, name: "c" },
      ],
    }),
  );
  assert.deepEqual(issues, ["events must be sorted by time"]);
});

test("validateClipMetadata does not range-check events against an invalid duration", () => {
  const issues = validateClipMetadata(clip({ duration: 0, events: [{ time: 5, name: "x" }] }));
  assert.deepEqual(issues, ["clip duration must be a finite positive number"]);
});

test("validateSkeletonProfile reports a physical bone mapped by two semantic bones", () => {
  const profile: SkeletonProfile = {
    id: "dup",
    bones: { hips: "Root", spine: "Root", head: "Head" },
  };
  const duplicates = validateSkeletonProfile(profile).filter(
    (d) => d.code === "skeleton.bone.duplicate-target",
  );
  assert.equal(duplicates.length, 1);
  assert.equal(duplicates[0]?.severity, "error");
  assert.equal(duplicates[0]?.semanticBone, "spine");
  assert.match(duplicates[0]?.message ?? "", /"Root" is mapped by both hips and spine/);
});

function machineGraph(): AnimationGraphDefinition {
  return {
    schemaVersion: 1,
    entryState: "idle",
    parameters: {
      speed: { type: "number", default: 3 },
      grounded: { type: "bool" },
      armed: { type: "bool", default: true },
      jump: { type: "trigger" },
    },
    states: [
      { id: "idle", clipId: "idle" },
      { id: "run", clipId: "run" },
    ],
    transitions: [],
  };
}

test("AnimationGraphMachine.reset(entryState) starts from the named state and restores defaults", () => {
  const machine = new AnimationGraphMachine(machineGraph());
  assert.deepEqual(machine.getParameters(), { speed: 3, grounded: false, armed: true });

  machine.set("speed", 9);
  machine.set("grounded", true);
  machine.set("armed", false);
  machine.trigger("jump");

  machine.reset("run");
  assert.equal(machine.state, "run");
  assert.deepEqual(machine.getParameters(), { speed: 3, grounded: false, armed: true });
  assert.equal(machine.hasTrigger("jump"), false);

  machine.reset();
  assert.equal(machine.state, "idle");
});

test("AnimationGraphMachine.reset rejects an unknown entry state without changing the machine", () => {
  const machine = new AnimationGraphMachine(machineGraph());
  machine.reset("run");
  machine.set("speed", 7);
  machine.trigger("jump");

  assert.throws(() => machine.reset("nope"), /Unknown entry state "nope"/);
  assert.equal(machine.state, "run");
  assert.equal(machine.getParameter("speed"), 7);
  assert.equal(machine.hasTrigger("jump"), true);
});

test("inspectSkeletonFromGlb reports retarget.skin.not-found for a GLB without a skin", async () => {
  const doc = new Document();
  doc.createBuffer();
  const scene = doc.createScene("Scene");
  scene.addChild(doc.createNode("Plain"));
  const bytes = await new NodeIO().writeBinary(doc);

  const result = await inspectSkeletonFromGlb(bytes);
  assert.deepEqual(result.bones, []);
  const missing = result.diagnostics.find((d) => d.code === "retarget.skin.not-found");
  assert.ok(missing, "expected a retarget.skin.not-found diagnostic");
  assert.equal(missing.severity, "warning");
});

test("bakeRetargetedClip skips tracks without a node.property delimiter and keeps the rest", () => {
  const profile: SkeletonProfile = { id: "p", bones: { hips: "Hips", spine: "Spine", head: "Head" } };
  const source = new THREE.AnimationClip("walk", 1, [
    new THREE.QuaternionKeyframeTrack("nodot", [0, 1], [0, 0, 0, 1, 0, 0, 0, 1]),
    new THREE.QuaternionKeyframeTrack("Spine.quaternion", [0, 1], [0, 0, 0, 1, 0, 0.7071, 0, 0.7071]),
  ]);

  const result = bakeRetargetedClip({ sourceClip: source, sourceProfile: profile, targetProfile: profile });
  const invalid = result.diagnostics.filter((d) => d.code === "retarget.track.invalid-name");
  assert.equal(invalid.length, 1);
  assert.equal(invalid[0]?.severity, "warning");
  assert.match(invalid[0]?.message ?? "", /Track "nodot"/);
  assert.ok(result.clip, "the valid Spine track should still bake");
  assert.deepEqual(result.clip.tracks.map((t) => t.name), ["Spine.quaternion"]);
});
