import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import {
  type BakeRetargetOptions,
  type SkeletonProfile,
  MemoryRetargetCacheStorage,
  RetargetBakeCache,
} from "../src/index.js";

const sourceProfile: SkeletonProfile = {
  id: "src",
  bones: { hips: "Src_Hips", spine: "Src_Spine", head: "Src_Head" },
};
const targetProfile: SkeletonProfile = {
  id: "dst",
  bones: { hips: "Hips", spine: "Spine", head: "Head" },
};

function sourceClip(): THREE.AnimationClip {
  const times = [0, 1];
  return new THREE.AnimationClip("walk", 1, [
    new THREE.QuaternionKeyframeTrack("Src_Spine.quaternion", times, [0, 0, 0, 1, 0, 0.7071, 0, 0.7071]),
  ]);
}

/** Storage whose writes fail (disk full, read-only dir, permission) while reads still work. */
class WriteFailingStorage extends MemoryRetargetCacheStorage {
  override async set(): Promise<void> {
    throw new Error("ENOSPC: no space left on device");
  }
}

class ReadFailingStorage extends MemoryRetargetCacheStorage {
  override async get(): Promise<string | null> {
    throw new Error("EIO: i/o error");
  }
}

function options(): BakeRetargetOptions {
  return {
    sourceClip: sourceClip(),
    sourceProfile,
    targetProfile,
    sourceAssetHash: "hash",
    settings: { hipsTranslationPolicy: "ignore", version: 1 },
  };
}

test("getOrBake still returns the baked clip when the cache cannot be written", async () => {
  const cache = new RetargetBakeCache({ storage: new WriteFailingStorage() });
  const result = await cache.getOrBake(options());
  assert.equal(result.success, true, "a cache write failure must not lose a successful bake");
  assert.equal(result.cacheHit, false);
  assert.ok(result.clip && result.clip.tracks.length > 0, "baked clip is returned");
  const diagnostic = result.diagnostics.find((d) => d.code === "retarget.cache.writeFailed");
  assert.ok(diagnostic, "the write failure is reported as a structured diagnostic");
  assert.equal(diagnostic.severity, "warning");
  assert.match(diagnostic.message, /ENOSPC/);
});

test("getOrBake bakes and reports storage_read_error when the cache cannot be read", async () => {
  const cache = new RetargetBakeCache({ storage: new ReadFailingStorage() });
  const result = await cache.getOrBake(options());
  assert.equal(result.success, true);
  assert.equal(result.regenerationReason, "storage_read_error");
});
