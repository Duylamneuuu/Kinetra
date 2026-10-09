import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as THREE from "three";
import {
  type RetargetCacheRecord,
  type SkeletonProfile,
  FileRetargetCacheStorage,
  MemoryRetargetCacheStorage,
  RETARGET_CACHE_SCHEMA_VERSION,
  RetargetBakeCache,
  bakeRetargetedClip,
  computeRetargetCacheKey,
  inspectRetargetedClip,
  skeletonSignature,
} from "../src/index.js";

const source: SkeletonProfile = {
  id: "src",
  bones: { hips: "SrcHips", spine: "SrcSpine" },
};
const target: SkeletonProfile = {
  id: "tgt",
  bones: { hips: "Hips", spine: "Spine" },
};

function clip(): THREE.AnimationClip {
  return new THREE.AnimationClip("walk", 1, [
    new THREE.QuaternionKeyframeTrack("SrcSpine.quaternion", [0, 1], [0, 0, 0, 1, 0, 0, 0, 1]),
  ]);
}

const quarterTurnY = (): [number, number, number, number] => [0, Math.SQRT1_2, 0, Math.SQRT1_2];

test("cache key changes when rest poses change (stale clips must not be reused)", () => {
  const base = { sourceClipId: "walk", source, target };
  const plain = computeRetargetCacheKey(base);
  const withPose = computeRetargetCacheKey({
    ...base,
    targetRestPoses: { Spine: { rotation: quarterTurnY() } },
  });
  const otherPose = computeRetargetCacheKey({
    ...base,
    targetRestPoses: { Spine: { rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2] } },
  });
  const sourcePose = computeRetargetCacheKey({
    ...base,
    sourceRestPoses: { SrcSpine: { rotation: quarterTurnY() } },
  });
  assert.equal(new Set([plain, withPose, otherPose, sourcePose]).size, 4);

  // Map vs record and insertion order must not matter.
  const asMap = computeRetargetCacheKey({
    ...base,
    targetRestPoses: new Map([
      ["Spine", { rotation: quarterTurnY() }],
      ["Hips", { translation: [0, 1, 0] as [number, number, number] }],
    ]),
  });
  const asRecord = computeRetargetCacheKey({
    ...base,
    targetRestPoses: {
      Hips: { translation: [0, 1, 0] },
      Spine: { rotation: quarterTurnY() },
    },
  });
  assert.equal(asMap, asRecord);
});

test("getOrBake re-bakes when only the target rest pose changed", async () => {
  const cache = new RetargetBakeCache({ storage: new MemoryRetargetCacheStorage() });
  const first = await cache.getOrBake({
    sourceClip: clip(),
    sourceProfile: source,
    targetProfile: target,
    sourceAssetHash: "h1",
  });
  assert.equal(first.success, true);
  assert.equal(first.cacheHit, false);

  const second = await cache.getOrBake({
    sourceClip: clip(),
    sourceProfile: source,
    targetProfile: target,
    sourceAssetHash: "h1",
    targetRestPoses: { Spine: { rotation: quarterTurnY() } },
  });
  assert.equal(second.cacheHit, false, "different rest pose must not hit the old entry");
  assert.notEqual(second.cacheKey, first.cacheKey);
  const track = second.clip!.tracks[0]!;
  assert.ok(Math.abs(track.values[1]! - Math.SQRT1_2) < 1e-4, "baked values use the new rest pose");

  const third = await cache.getOrBake({
    sourceClip: clip(),
    sourceProfile: source,
    targetProfile: target,
    sourceAssetHash: "h1",
    targetRestPoses: { Spine: { rotation: quarterTurnY() } },
  });
  assert.equal(third.cacheHit, true);
});

test("bakeRetargetedClip and getOrBake both fold rest poses into their cache key", async () => {
  const options = {
    sourceClip: clip(),
    sourceProfile: source,
    targetProfile: target,
    targetRestPoses: { Spine: { rotation: quarterTurnY() } },
  };
  const baked = bakeRetargetedClip(options);
  const cached = await new RetargetBakeCache().getOrBake(options);
  assert.equal(baked.success, true);
  assert.notEqual(baked.cacheKey, computeRetargetCacheKey({ sourceClipId: "walk", source, target }));
  assert.equal(cached.cacheKey, computeRetargetCacheKey({ ...options, sourceClipId: "walk", source, target }));
});

test("a stale record with mismatched metadata reports a regeneration reason", async () => {
  const storage = new MemoryRetargetCacheStorage();
  const cache = new RetargetBakeCache({ storage });
  const first = await cache.getOrBake({ sourceClip: clip(), sourceProfile: source, targetProfile: target });
  const record: RetargetCacheRecord = { ...first.record!, targetSkeletonSignature: "tampered" };
  assert.equal(record.schemaVersion, RETARGET_CACHE_SCHEMA_VERSION);
  await cache.put(first.cacheKey, record);

  const again = await cache.getOrBake({ sourceClip: clip(), sourceProfile: source, targetProfile: target });
  assert.equal(again.cacheHit, false);
  assert.equal(again.regenerationReason, "metadata_mismatch");
  assert.equal(again.record!.targetSkeletonSignature, skeletonSignature(target));
});

test("bone names containing dots (Blender style) retarget instead of being skipped", () => {
  const dottedSource: SkeletonProfile = {
    id: "dotted-src",
    bones: { hips: "Hips.001", leftUpperArm: "Arm.L" },
  };
  const dottedTarget: SkeletonProfile = {
    id: "dotted-tgt",
    bones: { hips: "Hips", leftUpperArm: "Upper.Arm.L" },
  };
  const sourceClip = new THREE.AnimationClip("wave", 1, [
    new THREE.QuaternionKeyframeTrack("Arm.L.quaternion", [0, 1], [0, 0, 0, 1, 0, 0, 0, 1]),
    new THREE.VectorKeyframeTrack("Hips.001.position", [0, 1], [0, 1, 0, 0, 1, 0]),
  ]);

  const result = bakeRetargetedClip({
    sourceClip,
    sourceProfile: dottedSource,
    targetProfile: dottedTarget,
    settings: { hipsTranslationPolicy: "preserve" },
  });
  assert.equal(result.success, true, JSON.stringify(result.diagnostics));
  assert.deepEqual(
    result.clip!.tracks.map((t) => t.name).sort(),
    ["Hips.position", "Upper.Arm.L.quaternion"],
  );
  assert.equal(
    result.diagnostics.filter((d) => d.code === "retarget.track.unsupported-binding").length,
    0,
  );

  const inspected = inspectRetargetedClip(result.clip!, dottedTarget);
  assert.deepEqual(inspected.unmappedTracks, []);
  assert.deepEqual(inspected.targetBonesAnimated, ["Hips", "Upper.Arm.L"]);
});

test("concurrent writes of the same cache key never collide on a temp file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kinetra-retarget-race-"));
  try {
    const storage = new FileRetargetCacheStorage({ cacheDir: dir });
    const payload = JSON.stringify({ hello: "world", pad: "x".repeat(4096) });
    const results = await Promise.allSettled(
      Array.from({ length: 24 }, () => storage.set("same-key", payload)),
    );
    const failures = results.filter((r) => r.status === "rejected");
    assert.equal(failures.length, 0, `unexpected failures: ${failures.map((f) => String((f as PromiseRejectedResult).reason)).join("; ")}`);
    assert.equal(readFileSync(join(dir, "same-key.json"), "utf-8"), payload);
    assert.deepEqual(readdirSync(dir), ["same-key.json"], "no temp files left behind");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
