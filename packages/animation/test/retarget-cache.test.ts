import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as THREE from "three";
import {
  type BakeRetargetOptions,
  type RetargetCacheRecord,
  type SkeletonProfile,
  FileRetargetCacheStorage,
  MemoryRetargetCacheStorage,
  RETARGET_CACHE_SCHEMA_VERSION,
  RetargetBakeCache,
  bakeRetargetedClip,
  computeRetargetCacheKey,
  skeletonSignature,
} from "../src/index.js";

// Sample test skeletons with different bone names
const sourceProfile: SkeletonProfile = {
  id: "artist_source",
  bones: {
    hips: "Skeleton_torso_1",
    spine: "Skeleton_torso_2",
    head: "Skeleton_head",
    leftUpperArm: "Skeleton_arm_L_1",
    leftLowerArm: "Skeleton_arm_L_2",
    leftHand: "Skeleton_arm_L_3",
    rightUpperArm: "Skeleton_arm_R_1",
    rightLowerArm: "Skeleton_arm_R_2",
    rightHand: "Skeleton_arm_R_3",
    leftUpperLeg: "Skeleton_leg_L_1",
    leftLowerLeg: "Skeleton_leg_L_2",
    leftFoot: "Skeleton_leg_L_3",
    rightUpperLeg: "Skeleton_leg_R_1",
    rightLowerLeg: "Skeleton_leg_R_2",
    rightFoot: "Skeleton_leg_R_3",
  },
};

const targetProfile: SkeletonProfile = {
  id: "kinetra_target",
  bones: {
    hips: "Hips",
    spine: "Spine",
    head: "Head",
    leftUpperArm: "LeftArm",
    leftLowerArm: "LeftForeArm",
    leftHand: "LeftHand",
    rightUpperArm: "RightArm",
    rightLowerArm: "RightForeArm",
    rightHand: "RightHand",
    leftUpperLeg: "LeftUpLeg",
    leftLowerLeg: "LeftLeg",
    leftFoot: "LeftFoot",
    rightUpperLeg: "RightUpLeg",
    rightLowerLeg: "RightLeg",
    rightFoot: "RightFoot",
  },
};

function createSampleSourceClip(): THREE.AnimationClip {
  const times = [0, 0.5, 1.0];
  const qValues = [
    0, 0, 0, 1,
    0, 0.7071, 0, 0.7071,
    0, 0, 0, 1,
  ];
  const posValues = [
    0, 1, 0,
    0, 1.2, 0,
    0, 1, 0,
  ];

  const tracks = [
    new THREE.QuaternionKeyframeTrack("Skeleton_torso_1.quaternion", times, qValues),
    new THREE.VectorKeyframeTrack("Skeleton_torso_1.position", times, posValues),
    new THREE.QuaternionKeyframeTrack("Skeleton_arm_L_1.quaternion", times, qValues),
    new THREE.QuaternionKeyframeTrack("Skeleton_leg_L_1.quaternion", times, qValues),
  ];

  return new THREE.AnimationClip("sample_walk", 1.0, tracks);
}

function assertClipsEquivalent(clipA: THREE.AnimationClip, clipB: THREE.AnimationClip): void {
  assert.equal(clipA.name, clipB.name, "Clip names must match");
  assert.ok(Math.abs(clipA.duration - clipB.duration) < 1e-4, "Clip durations must match");
  assert.equal(clipA.tracks.length, clipB.tracks.length, "Clip track counts must match");

  for (let i = 0; i < clipA.tracks.length; i++) {
    const tA = clipA.tracks[i]!;
    const tB = clipB.tracks[i]!;
    assert.equal(tA.name, tB.name, `Track ${i} name must match`);
    assert.equal(tA.times.length, tB.times.length, `Track ${i} times length must match`);
    for (let j = 0; j < tA.times.length; j++) {
      assert.ok(Math.abs(tA.times[j]! - tB.times[j]!) < 1e-4, `Track ${i} time[${j}] must match`);
    }
    assert.equal(tA.values.length, tB.values.length, `Track ${i} values length must match`);
    for (let j = 0; j < tA.values.length; j++) {
      assert.ok(Math.abs(tA.values[j]! - tB.values[j]!) < 1e-4, `Track ${i} value[${j}] must match`);
    }
  }
}

test("Retarget cache key is deterministic and sensitive to all material inputs", () => {
  const baseInput = {
    sourceAssetHash: "sha256_source_111",
    sourceClipId: "sample_walk",
    source: sourceProfile,
    target: targetProfile,
    semanticMapping: [
      { semantic: "hips", sourceBone: "Skeleton_torso_1", targetBone: "Hips" },
      { semantic: "spine", sourceBone: "Skeleton_torso_2", targetBone: "Spine" },
    ],
    settings: { hipsTranslationPolicy: "ignore" as const, scaleFactor: 1.0 },
    retargetVersion: 1,
  };

  const key1 = computeRetargetCacheKey(baseInput);
  const key2 = computeRetargetCacheKey({ ...baseInput });
  assert.equal(key1, key2, "Equivalent inputs must produce identical cache keys");
  assert.ok(/^[a-f0-9]{64}$/.test(key1), "Key must be 64-char sha256 hex");

  // Invalidation: sourceAssetHash
  assert.notEqual(key1, computeRetargetCacheKey({ ...baseInput, sourceAssetHash: "sha256_source_222" }));

  // Invalidation: sourceClipId
  assert.notEqual(key1, computeRetargetCacheKey({ ...baseInput, sourceClipId: "run_cycle" }));

  // Invalidation: source skeleton signature
  const modSource: SkeletonProfile = {
    id: "mod_src",
    bones: { ...sourceProfile.bones, head: "Skeleton_head_v2" },
  };
  assert.notEqual(key1, computeRetargetCacheKey({ ...baseInput, source: modSource }));

  // Invalidation: target skeleton signature
  const modTarget: SkeletonProfile = {
    id: "mod_tgt",
    bones: { ...targetProfile.bones, head: "NewHead" },
  };
  assert.notEqual(key1, computeRetargetCacheKey({ ...baseInput, target: modTarget }));

  // Invalidation: semantic mapping
  const modMapping = [
    { semantic: "hips", sourceBone: "Skeleton_torso_1", targetBone: "Pelvis" },
    { semantic: "spine", sourceBone: "Skeleton_torso_2", targetBone: "Spine" },
  ];
  assert.notEqual(key1, computeRetargetCacheKey({ ...baseInput, semanticMapping: modMapping }));

  // Invalidation: retarget settings
  assert.notEqual(
    key1,
    computeRetargetCacheKey({
      ...baseInput,
      settings: { hipsTranslationPolicy: "relative", scaleFactor: 1.5 },
    }),
  );

  // Invalidation: retarget version
  assert.notEqual(key1, computeRetargetCacheKey({ ...baseInput, retargetVersion: 2 }));
});

test("RetargetBakeCache: proves 12 correctness requirements on MemoryRetargetCacheStorage", async () => {
  const storage = new MemoryRetargetCacheStorage();
  const cache = new RetargetBakeCache({ storage });
  const sourceClip = createSampleSourceClip();

  let bakeCallCount = 0;
  const spyBakeFn = (opts: BakeRetargetOptions) => {
    bakeCallCount++;
    return bakeRetargetedClip(opts);
  };

  const baseOptions: BakeRetargetOptions & { bakeFn: typeof spyBakeFn } = {
    sourceClip,
    sourceProfile,
    targetProfile,
    sourceAssetHash: "source_hash_alpha",
    settings: { hipsTranslationPolicy: "ignore", version: 1 },
    bakeFn: spyBakeFn,
  };

  // Requirement 1: First request is a cache MISS
  const res1 = await cache.getOrBake(baseOptions);
  assert.equal(res1.success, true, "First bake must succeed");
  assert.equal(res1.cacheHit, false, "Req 1: First request must be a cache MISS");
  assert.equal(res1.regenerationReason, undefined, "First miss has no prior corrupt reason");

  // Requirement 2: Real retarget baking runs
  assert.equal(bakeCallCount, 1, "Req 2: Real retarget baking function must execute on MISS");
  assert.ok(res1.clip, "Baked clip must exist");
  assert.ok(res1.clip.tracks.length > 0, "Baked clip must contain tracks");

  // Requirement 3: Baked artifact is persisted in storage
  const persistedRaw = await storage.get(res1.cacheKey);
  assert.ok(persistedRaw !== null, "Req 3: Baked artifact must be persisted");
  const persistedRecord = JSON.parse(persistedRaw) as RetargetCacheRecord;
  assert.equal(persistedRecord.schemaVersion, RETARGET_CACHE_SCHEMA_VERSION, "Schema version must match");
  assert.equal(persistedRecord.cacheKey, res1.cacheKey, "Cache key in record must match");
  assert.equal(persistedRecord.sourceAssetHash, "source_hash_alpha", "sourceAssetHash must match");
  assert.equal(persistedRecord.sourceSkeletonSignature, skeletonSignature(sourceProfile), "source signature matches");
  assert.equal(persistedRecord.targetSkeletonSignature, skeletonSignature(targetProfile), "target signature matches");

  // Structured observation fields check
  assert.ok(/^[a-f0-9]{64}$/.test(res1.cacheKey), "cacheKey must be 64-char sha256 hex");
  assert.equal(res1.cacheIdentity, `retarget/${res1.cacheKey}.json`, "cacheIdentity must be canonical");
  assert.equal(res1.cachePath, `retarget/${res1.cacheKey}.json`, "cachePath must match canonical identity");
  assert.ok(res1.bakedClipName && res1.bakedClipName.length > 0, "bakedClipName must be exposed");
  assert.ok(res1.trackCount > 0, "trackCount must be exposed");

  // Requirement 4: Identical second request is a cache HIT
  const res2 = await cache.getOrBake(baseOptions);
  assert.equal(res2.success, true, "Second request must succeed");
  assert.equal(res2.cacheHit, true, "Req 4: Second request must be a cache HIT");
  assert.equal(res2.cacheKey, res1.cacheKey, "Cache keys must be identical");

  // Requirement 5: Second request does NOT recompute retargeting
  assert.equal(bakeCallCount, 1, "Req 5: Bake function must NOT run on cache HIT");

  // Requirement 6: Loaded cached clip is equivalent to the original baked clip
  assertClipsEquivalent(res1.clip, res2.clip!);

  // Requirement 7: Changed source asset hash invalidates
  const resHashChange = await cache.getOrBake({
    ...baseOptions,
    sourceAssetHash: "source_hash_beta",
  });
  assert.equal(resHashChange.cacheHit, false, "Req 7: Changed sourceAssetHash must be a cache MISS");
  assert.equal(bakeCallCount, 2, "Bake function must re-run for changed sourceAssetHash");

  // Requirement 8: Changed mapping invalidates
  const modSourceMapping: SkeletonProfile = {
    id: "source_remap",
    bones: { ...sourceProfile.bones, head: "Skeleton_custom_head" },
  };
  const resMappingChange = await cache.getOrBake({
    ...baseOptions,
    sourceProfile: modSourceMapping,
  });
  assert.equal(resMappingChange.cacheHit, false, "Req 8: Changed source profile mapping must be a cache MISS");
  assert.equal(bakeCallCount, 3, "Bake function must re-run for changed source profile");

  // Requirement 9: Changed target skeleton invalidates
  const modTargetSkeleton: SkeletonProfile = {
    id: "target_remap",
    bones: { ...targetProfile.bones, head: "NewTargetHead" },
  };
  const resTargetChange = await cache.getOrBake({
    ...baseOptions,
    targetProfile: modTargetSkeleton,
  });
  assert.equal(resTargetChange.cacheHit, false, "Req 9: Changed target skeleton must be a cache MISS");
  assert.equal(bakeCallCount, 4, "Bake function must re-run for changed target skeleton");

  // Requirement 10: Changed settings/version invalidates
  const resSettingsChange = await cache.getOrBake({
    ...baseOptions,
    settings: { hipsTranslationPolicy: "relative", version: 2 },
  });
  assert.equal(resSettingsChange.cacheHit, false, "Req 10: Changed settings must be a cache MISS");
  assert.equal(bakeCallCount, 5, "Bake function must re-run for changed settings");

  // Requirement 11: Corrupt cache artifact fails safely and regenerates
  const corruptKey = res1.cacheKey;
  await storage.set(corruptKey, "{ not valid json: truncated content");
  const resCorrupt = await cache.getOrBake(baseOptions);
  assert.equal(resCorrupt.success, true, "Req 11: Corrupt artifact must not crash, must recover");
  assert.equal(resCorrupt.cacheHit, false, "Must miss due to corruption");
  assert.equal(resCorrupt.regenerationReason, "corrupt_json", "Must report corrupt_json regenerationReason");
  assert.equal(bakeCallCount, 6, "Must re-bake when corrupt");
  // Confirm storage was healed
  const healedRaw = await storage.get(corruptKey);
  assert.doesNotThrow(() => JSON.parse(healedRaw!), "Storage must contain valid healed JSON");

  // Requirement 12: Stale/incompatible schema fails safely and regenerates
  const staleRecord: RetargetCacheRecord = {
    ...persistedRecord,
    schemaVersion: 999, // incompatible schema
  };
  await storage.set(corruptKey, JSON.stringify(staleRecord));
  const resStale = await cache.getOrBake(baseOptions);
  assert.equal(resStale.success, true, "Req 12: Stale schema must recover gracefully");
  assert.equal(resStale.cacheHit, false, "Must miss due to incompatible schema");
  assert.equal(resStale.regenerationReason, "incompatible_schema_version", "Must report incompatible_schema_version");
  assert.equal(bakeCallCount, 7, "Must re-bake on incompatible schema");
});

test("FileRetargetCacheStorage: proves atomic disk persistence, path traversal protection, and multi-instance sharing", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "kinetra-cache-test-"));

  try {
    const storage1 = new FileRetargetCacheStorage({ cacheDir: tmpDir });
    const cache1 = new RetargetBakeCache({ storage: storage1 });
    const sourceClip = createSampleSourceClip();

    const bakeOptions: BakeRetargetOptions = {
      sourceClip,
      sourceProfile,
      targetProfile,
      sourceAssetHash: "disk_source_hash",
      settings: { hipsTranslationPolicy: "ignore", version: 1 },
    };

    // First instance: MISS -> bake -> save to disk
    const resA = await cache1.getOrBake(bakeOptions);
    assert.equal(resA.cacheHit, false, "Instance 1 must be MISS");
    assert.equal(await storage1.has(resA.cacheKey), true, "File must exist on disk");

    // Path traversal security check
    await assert.rejects(
      async () => storage1.get("../escape"),
      /Invalid retarget cache key format/,
      "Must reject malicious keys with traversal characters",
    );
    await assert.rejects(
      async () => storage1.get("invalid/key"),
      /Invalid retarget cache key format/,
      "Must reject keys containing slashes",
    );
    await assert.rejects(
      async () => storage1.set("../escape", "data"),
      /Invalid retarget cache key format/,
      "Must reject malicious keys in set",
    );

    // Second independent instance pointing to same directory: HIT without re-baking
    const storage2 = new FileRetargetCacheStorage({ cacheDir: tmpDir });
    const cache2 = new RetargetBakeCache({ storage: storage2 });

    let bake2Called = false;
    const resB = await cache2.getOrBake({
      ...bakeOptions,
      bakeFn: (opts) => {
        bake2Called = true;
        return bakeRetargetedClip(opts);
      },
    });

    assert.equal(resB.cacheHit, true, "Instance 2 must be cache HIT from persisted disk file");
    assert.equal(bake2Called, false, "Instance 2 must not invoke retarget bake function");
    assertClipsEquivalent(resA.clip!, resB.clip!);

    // Canonical identity format must not contain absolute directory paths
    assert.equal(resB.cacheIdentity, `retarget/${resB.cacheKey}.json`);
    assert.ok(!resB.cacheIdentity.includes(tmpDir), "cacheIdentity must never leak local filesystem path");
    assert.equal(resB.cachePath, `retarget/${resB.cacheKey}.json`);
  } finally {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup error
    }
  }
});
