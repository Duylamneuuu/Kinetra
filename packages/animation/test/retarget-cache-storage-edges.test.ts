import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as THREE from "three";
import {
  type BakeRetargetOptions,
  type RetargetCacheRecord,
  type RetargetCacheStorage,
  type SkeletonProfile,
  FileRetargetCacheStorage,
  MemoryRetargetCacheStorage,
  RETARGET_CACHE_SCHEMA_VERSION,
  RetargetBakeCache,
  bakeRetargetedClip,
} from "../src/index.js";

const sourceProfile: SkeletonProfile = {
  id: "edge_source",
  bones: { hips: "Src_hips", spine: "Src_spine", head: "Src_head" },
};
const targetProfile: SkeletonProfile = {
  id: "edge_target",
  bones: { hips: "Hips", spine: "Spine", head: "Head" },
};

function sourceClip(): THREE.AnimationClip {
  const times = [0, 1];
  const q = [0, 0, 0, 1, 0, 0.7071, 0, 0.7071];
  return new THREE.AnimationClip("edge_walk", 1, [
    new THREE.QuaternionKeyframeTrack("Src_hips.quaternion", times, q),
    new THREE.QuaternionKeyframeTrack("Src_spine.quaternion", times, q),
  ]);
}

type GetOrBakeOptions = Parameters<RetargetBakeCache["getOrBake"]>[0];

function options(extra: Partial<GetOrBakeOptions> = {}): GetOrBakeOptions {
  return {
    sourceClip: sourceClip(),
    sourceProfile,
    targetProfile,
    sourceAssetHash: "edge_hash",
    settings: { hipsTranslationPolicy: "ignore", version: 1 },
    ...extra,
  };
}

function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "kinetra-retarget-edges-"));
  return run(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("MemoryRetargetCacheStorage: get/set/has/delete round-trip and report absence honestly", async () => {
  const storage = new MemoryRetargetCacheStorage();
  assert.equal(await storage.get("k"), null);
  assert.equal(await storage.has("k"), false);
  assert.equal(await storage.delete("k"), false);

  await storage.set("k", "one");
  await storage.set("k", "two");
  assert.equal(await storage.get("k"), "two", "the second write replaces the first");
  assert.equal(await storage.has("k"), true);
  assert.equal(await storage.delete("k"), true);
  assert.equal(await storage.delete("k"), false, "deleting twice reports that nothing was left");
  assert.equal(await storage.get("k"), null);

  await storage.set("empty", "");
  assert.equal(await storage.get("empty"), "", "an empty payload is a stored value, not a miss");
  assert.equal(storage.resolveIdentity("abc"), "retarget/abc.json");
});

test("FileRetargetCacheStorage: absent keys read as null/false, writes replace, deletes are idempotent", async () => {
  await withTempDir(async (dir) => {
    const storage = new FileRetargetCacheStorage({ cacheDir: dir });
    assert.equal(await storage.get("missing"), null);
    assert.equal(await storage.has("missing"), false);
    assert.equal(await storage.delete("missing"), false);

    await storage.set("key", "first");
    await storage.set("key", "second");
    assert.equal(await storage.get("key"), "second");
    assert.equal(await storage.has("key"), true);
    assert.equal(readFileSync(join(dir, "key.json"), "utf-8"), "second");

    assert.equal(await storage.delete("key"), true);
    assert.equal(await storage.delete("key"), false);
    assert.equal(await storage.has("key"), false);
    assert.deepEqual(readdirSync(dir), [], "no temp files are left behind");
  });
});

test("FileRetargetCacheStorage: the constructor creates a nested cache directory", async () => {
  await withTempDir(async (dir) => {
    const nested = join(dir, "a", "b", "retarget");
    const storage = new FileRetargetCacheStorage({ cacheDir: nested });
    await storage.set("k", "v");
    assert.equal(readFileSync(join(nested, "k.json"), "utf-8"), "v");
  });
});

test("FileRetargetCacheStorage: every method rejects malformed keys and never touches the disk outside the cache dir", async () => {
  await withTempDir(async (dir) => {
    const cacheDir = join(dir, "cache");
    const storage = new FileRetargetCacheStorage({ cacheDir });
    const bad = ["", "a/b", "a\\b", "a b", "../x", "x\u0000y", "é", "a:b", "a*b"];
    for (const key of bad) {
      await assert.rejects(storage.get(key), /Invalid retarget cache key format/, `get(${JSON.stringify(key)})`);
      await assert.rejects(storage.set(key, "x"), /Invalid retarget cache key format/, `set(${JSON.stringify(key)})`);
      await assert.rejects(storage.has(key), /Invalid retarget cache key format/, `has(${JSON.stringify(key)})`);
      await assert.rejects(storage.delete(key), /Invalid retarget cache key format/, `delete(${JSON.stringify(key)})`);
    }
    assert.deepEqual(readdirSync(dir), ["cache"], "nothing was written next to the cache dir");
    assert.deepEqual(readdirSync(cacheDir), []);
  });
});

// Documents current behaviour on purpose: the key charset allows dots, and `${key}.json` can never
// climb out of the directory. Tightening the validator to reject "." and ".." would make this test the
// one to update.
test("FileRetargetCacheStorage: dot-only keys stay inside the cache dir as ordinary file names", async () => {
  await withTempDir(async (dir) => {
    const cacheDir = join(dir, "cache");
    const storage = new FileRetargetCacheStorage({ cacheDir });
    for (const key of [".", ".."]) {
      await storage.set(key, `value-${key}`);
      assert.equal(await storage.get(key), `value-${key}`);
    }
    assert.deepEqual(readdirSync(dir), ["cache"]);
    assert.deepEqual(readdirSync(cacheDir).sort(), ["...json", "..json"]);
  });
});

test("FileRetargetCacheStorage: concurrent writers of one key leave one complete value and no temp files", async () => {
  await withTempDir(async (dir) => {
    const storage = new FileRetargetCacheStorage({ cacheDir: dir });
    const payloads = Array.from({ length: 24 }, (_, index) => `payload-${index}-${"x".repeat(2048 + index)}`);
    // On Windows a rename over a file another writer is replacing can exhaust the retry budget and
    // reject; that is allowed. What must hold everywhere is that no reader ever sees a torn value.
    const settled = await Promise.allSettled(payloads.map((payload) => storage.set("shared", payload)));
    assert.ok(settled.some((outcome) => outcome.status === "fulfilled"), "at least one writer wins");
    for (const outcome of settled) {
      if (outcome.status === "rejected") {
        assert.ok(outcome.reason instanceof Error, "a lost race rejects with a real error");
      }
    }
    const final = await storage.get("shared");
    assert.ok(final !== null && payloads.includes(final), "the stored value is one whole payload, never a mix");
    assert.deepEqual(readdirSync(dir), ["shared.json"], "losing writers clean up their temp files");
  });
});

test("FileRetargetCacheStorage: a non-ENOENT read error propagates and the cache reports storage_read_error", async () => {
  await withTempDir(async (dir) => {
    const storage = new FileRetargetCacheStorage({ cacheDir: dir });
    // A directory where the cache file should be: readFile fails with EISDIR, not ENOENT.
    mkdirSync(join(dir, "dirkey.json"));
    await assert.rejects(storage.get("dirkey"), (error: NodeJS.ErrnoException) => error.code === "EISDIR");
    await assert.rejects(storage.delete("dirkey"), (error: NodeJS.ErrnoException) => error.code !== "ENOENT");

    const cache = new RetargetBakeCache({ storage });
    assert.deepEqual(await cache.get("dirkey"), { hit: false, reason: "storage_read_error" });
  });
});

test("RetargetBakeCache: the constructor picks file storage for cacheDir and memory storage otherwise", async () => {
  await withTempDir(async (dir) => {
    const onDisk = new RetargetBakeCache({ cacheDir: join(dir, "disk") });
    assert.ok(onDisk.storage instanceof FileRetargetCacheStorage);
    const first = await onDisk.getOrBake(options());
    assert.equal(first.cacheHit, false);
    assert.deepEqual(readdirSync(join(dir, "disk")), [`${first.cacheKey}.json`]);

    const inMemory = new RetargetBakeCache();
    assert.ok(inMemory.storage instanceof MemoryRetargetCacheStorage);
    const explicit = new MemoryRetargetCacheStorage();
    assert.equal(new RetargetBakeCache({ storage: explicit, cacheDir: join(dir, "ignored") }).storage, explicit);
  });
});

test("RetargetBakeCache.get: every malformed record maps to its own structured miss reason", async () => {
  const storage = new MemoryRetargetCacheStorage();
  const cache = new RetargetBakeCache({ storage });
  const baked = await cache.getOrBake(options());
  const good = JSON.parse((await storage.get(baked.cacheKey))!) as RetargetCacheRecord;
  const key = baked.cacheKey;

  const reasonFor = async (raw: string | undefined): Promise<string | undefined> => {
    if (raw === undefined) {
      await storage.delete(key);
    } else {
      await storage.set(key, raw);
    }
    const result = await cache.get(key);
    assert.equal(result.hit, false);
    assert.equal(result.clip, undefined);
    assert.equal(result.record, undefined);
    return result.reason;
  };

  assert.equal(await reasonFor(undefined), "miss");
  assert.equal(await reasonFor(""), "corrupt_json");
  assert.equal(await reasonFor("{"), "corrupt_json");
  assert.equal(await reasonFor("null"), "invalid_record_structure");
  assert.equal(await reasonFor("42"), "invalid_record_structure");
  assert.equal(await reasonFor('"text"'), "invalid_record_structure");
  assert.equal(await reasonFor("[]"), "invalid_record_structure");
  assert.equal(await reasonFor("{}"), "incompatible_schema_version");
  assert.equal(
    await reasonFor(JSON.stringify({ ...good, schemaVersion: String(RETARGET_CACHE_SCHEMA_VERSION) })),
    "incompatible_schema_version",
    "a stringified version is not the current version",
  );
  assert.equal(await reasonFor(JSON.stringify({ ...good, schemaVersion: RETARGET_CACHE_SCHEMA_VERSION + 1 })), "incompatible_schema_version");
  assert.equal(await reasonFor(JSON.stringify({ ...good, cacheKey: "somebody-else" })), "cache_key_mismatch");
  const withoutClip: Partial<RetargetCacheRecord> = { ...good };
  delete withoutClip.clip;
  assert.equal(await reasonFor(JSON.stringify(withoutClip)), "invalid_record_structure");
  assert.equal(await reasonFor(JSON.stringify({ ...good, clip: "not an object" })), "invalid_record_structure");
  assert.equal(await reasonFor(JSON.stringify({ ...good, clip: null })), "invalid_record_structure");
  assert.equal(await reasonFor(JSON.stringify({ ...good, clip: {} })), "corrupt_clip_data");
  assert.equal(await reasonFor(JSON.stringify({ ...good, clip: { ...good.clip, tracks: [] } })), "corrupt_clip_data");
  assert.equal(await reasonFor(JSON.stringify({ ...good, clip: { ...good.clip, tracks: [{}] } })), "corrupt_clip_data");
  assert.equal(await reasonFor(JSON.stringify({ ...good, clip: { ...good.clip, tracks: "nope" } })), "corrupt_clip_data");

  // The untouched record still hits, so the reasons above are about the damage and not the setup.
  await storage.set(key, JSON.stringify(good));
  const hit = await cache.get(key);
  assert.equal(hit.hit, true);
  assert.equal(hit.clip?.tracks.length, good.clip.tracks.length);
});

test("RetargetBakeCache.getOrBake: a record whose metadata disagrees with the request is regenerated as metadata_mismatch", async () => {
  const storage = new MemoryRetargetCacheStorage();
  const cache = new RetargetBakeCache({ storage });
  const first = await cache.getOrBake(options());
  const record = JSON.parse((await storage.get(first.cacheKey))!) as RetargetCacheRecord;

  for (const tampered of [
    { sourceAssetHash: "other-hash" },
    { sourceSkeletonSignature: "other-source-signature" },
    { targetSkeletonSignature: "other-target-signature" },
  ]) {
    await storage.set(first.cacheKey, JSON.stringify({ ...record, ...tampered }));
    let bakes = 0;
    const result = await cache.getOrBake(
      options({
        bakeFn: (bakeOptions: BakeRetargetOptions) => {
          bakes += 1;
          return bakeRetargetedClip(bakeOptions);
        },
      }),
    );
    assert.equal(result.success, true);
    assert.equal(result.cacheHit, false, `tampered ${Object.keys(tampered)[0]} must not be served`);
    assert.equal(result.regenerationReason, "metadata_mismatch");
    assert.equal(bakes, 1);
    // The write-back heals the record: the next identical request is a clean hit.
    const healed = await cache.getOrBake(options());
    assert.equal(healed.cacheHit, true);
  }
});

test("RetargetBakeCache.getOrBake: a failed bake reports the error, keeps the regeneration reason and writes nothing", async () => {
  const storage = new MemoryRetargetCacheStorage();
  const cache = new RetargetBakeCache({ storage });
  const failing = (bakeOptions: BakeRetargetOptions) => ({
    ...bakeRetargetedClip(bakeOptions),
    success: false,
    clip: undefined,
    error: "boom",
  });

  const clean = await cache.getOrBake(options({ bakeFn: failing }));
  assert.equal(clean.success, false);
  assert.equal(clean.cacheHit, false);
  assert.equal(clean.error, "boom");
  assert.equal(clean.regenerationReason, undefined, "a plain miss has no regeneration reason");
  assert.equal(clean.trackCount, 0);
  assert.equal(await storage.has(clean.cacheKey), false, "nothing is cached for a failed bake");

  await storage.set(clean.cacheKey, "{ broken");
  const afterCorrupt = await cache.getOrBake(options({ bakeFn: failing }));
  assert.equal(afterCorrupt.success, false);
  assert.equal(afterCorrupt.regenerationReason, "corrupt_json");
  assert.equal(await storage.get(clean.cacheKey), "{ broken", "a failed bake leaves the damaged record for the next attempt");

  const noError = await cache.getOrBake(options({ bakeFn: (bakeOptions: BakeRetargetOptions) => ({ ...failing(bakeOptions), error: undefined }) }));
  assert.equal(noError.error, "Retarget baking failed", "a missing error message gets a stable default");
});

test("RetargetBakeCache.getOrBake: a storage that cannot read still bakes, and one that cannot write still returns the clip", async () => {
  class Broken implements RetargetCacheStorage {
    readonly writes: string[] = [];
    constructor(private readonly failRead: boolean, private readonly failWrite: boolean) {}
    async get(): Promise<string | null> {
      if (this.failRead) throw new Error("read denied");
      return null;
    }
    async set(key: string): Promise<void> {
      this.writes.push(key);
      if (this.failWrite) throw new Error("disk full");
    }
    async has(): Promise<boolean> {
      return false;
    }
    async delete(): Promise<boolean> {
      return false;
    }
    resolveIdentity(key: string): string {
      return `broken/${key}`;
    }
  }

  const unreadable = new Broken(true, false);
  const readFail = await new RetargetBakeCache({ storage: unreadable }).getOrBake(options());
  assert.equal(readFail.success, true);
  assert.equal(readFail.cacheHit, false);
  assert.equal(readFail.regenerationReason, "storage_read_error");
  assert.equal(readFail.cacheIdentity, `broken/${readFail.cacheKey}`);
  assert.equal(unreadable.writes.length, 1, "the baked clip is still offered to storage");

  const unwritable = new Broken(false, true);
  const writeFail = await new RetargetBakeCache({ storage: unwritable }).getOrBake(options());
  assert.equal(writeFail.success, true);
  assert.ok(writeFail.clip && writeFail.clip.tracks.length > 0);
  const warning = writeFail.diagnostics.find((diagnostic) => diagnostic.code === "retarget.cache.writeFailed");
  assert.ok(warning, "the lost write is surfaced as a structured diagnostic");
  assert.equal(warning.severity, "warning");
  assert.match(warning.message, /disk full/);
});

test("RetargetBakeCache: file storage ignores stray non-cache files in the directory", async () => {
  await withTempDir(async (dir) => {
    writeFileSync(join(dir, "notes.txt"), "unrelated");
    const cache = new RetargetBakeCache({ cacheDir: dir });
    const first = await cache.getOrBake(options());
    const second = await cache.getOrBake(options());
    assert.equal(first.cacheHit, false);
    assert.equal(second.cacheHit, true);
    assert.deepEqual(readdirSync(dir).sort(), ["notes.txt", `${first.cacheKey}.json`].sort());
  });
});
