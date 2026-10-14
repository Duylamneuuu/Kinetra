import assert from "node:assert/strict";
import test from "node:test";

import { createSyntheticGlb } from "@kinetra/asset-pipeline";
import * as THREE from "three";
import type { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

import { ModelTemplateCache, type AssetResolver } from "../src/index.js";

/** A resolver that hands back whatever the test wants, whatever its type. */
function resolverOf(value: unknown): AssetResolver {
  return { resolve: async () => value as never };
}

interface FakeLoader {
  loader: GLTFLoader;
  loadCalls: string[];
  parseCalls: number;
}

/** Stands in for GLTFLoader: `scene: false` simulates a file that parses but has no scene. */
function fakeLoader(options: { scene: boolean }): FakeLoader {
  const state: FakeLoader = { loader: undefined as never, loadCalls: [], parseCalls: 0 };
  const result = () => (options.scene ? { scene: new THREE.Group(), animations: [] } : { animations: [] });
  state.loader = {
    loadAsync: async (url: string) => {
      state.loadCalls.push(url);
      return result();
    },
    parseAsync: async () => {
      state.parseCalls++;
      return result();
    },
  } as unknown as GLTFLoader;
  return state;
}

test("template sources: a Uint8Array view with a byte offset is copied, not detached or misread", async () => {
  const glb = await createSyntheticGlb({ size: [1, 1, 1] });
  const backing = new Uint8Array(glb.byteLength + 24);
  backing.set(glb, 8);
  const view = backing.subarray(8, 8 + glb.byteLength);

  const cache = new ModelTemplateCache();
  const template = await cache.resolveTemplate("model_view", resolverOf(view));

  assert.equal(cache.get("model_view"), template);
  assert.equal(cache.parseCount, 1);
  assert.equal(backing.buffer.byteLength, glb.byteLength + 24, "the caller's buffer is left intact");
  assert.deepEqual([...view.subarray(0, 4)], [...glb.subarray(0, 4)]);
});

test("template sources: a plain ArrayBuffer is parsed", async () => {
  const glb = await createSyntheticGlb({ size: [1, 2, 1] });
  const exact = glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength) as ArrayBuffer;

  const cache = new ModelTemplateCache();
  const template = await cache.resolveTemplate("model_ab", resolverOf(exact));

  assert.equal(template.assetId, "model_ab");
  assert.equal(cache.has("model_ab"), true);
});

test("template sources: a base64 data URL is decoded and parsed without touching the URL loader", async () => {
  const glb = await createSyntheticGlb({ size: [1, 1, 1] });
  const url = `data:model/gltf-binary;base64,${Buffer.from(glb).toString("base64")}`;

  const cache = new ModelTemplateCache();
  const template = await cache.resolveTemplate("model_data", resolverOf(url));

  assert.equal(template.assetId, "model_data");
  assert.equal(cache.parseCount, 1);
});

test("template sources: a non-base64 data URL and a plain URL go through loader.loadAsync", async () => {
  const cache = new ModelTemplateCache();
  const loader = fakeLoader({ scene: true });

  await cache.resolveTemplate("model_text", resolverOf("data:text/plain,hello"), loader.loader);
  await cache.resolveTemplate("model_url", resolverOf("https://example.test/m.glb"), loader.loader);

  assert.deepEqual(loader.loadCalls, ["data:text/plain,hello", "https://example.test/m.glb"]);
  assert.equal(loader.parseCalls, 0);
  assert.equal(cache.parseCount, 2);
  assert.equal(cache.has("model_text"), true);
  assert.equal(cache.has("model_url"), true);
});

test("template sources: a URL that loads without a scene is rejected and never cached", async () => {
  const cache = new ModelTemplateCache();
  const loader = fakeLoader({ scene: false });

  await assert.rejects(
    cache.resolveTemplate("model_empty_url", resolverOf("https://example.test/e.glb"), loader.loader),
    /\[model\.instance\.templateInvalid\].*model_empty_url.*no valid scene/,
  );
  await assert.rejects(
    cache.resolveTemplate("model_empty_data", resolverOf("data:text/plain,x"), loader.loader),
    /\[model\.instance\.templateInvalid\].*no valid scene/,
  );
  assert.equal(cache.has("model_empty_url"), false);
  assert.equal(cache.has("model_empty_data"), false);
});

test("template sources: bytes that parse without a scene are rejected as templateInvalid", async () => {
  const cache = new ModelTemplateCache();
  const loader = fakeLoader({ scene: false });

  await assert.rejects(
    cache.resolveTemplate("model_sceneless", resolverOf(new Uint8Array([1, 2, 3])), loader.loader),
    /\[model\.instance\.templateInvalid\].*no valid scene/,
  );
  assert.equal(loader.parseCalls, 1);
  assert.equal(cache.has("model_sceneless"), false);
});

test("template sources: garbage bytes fail with a structured parse error naming the asset", async () => {
  const cache = new ModelTemplateCache();

  await assert.rejects(
    cache.resolveTemplate("model_garbage", resolverOf(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]))),
    /\[model\.instance\.templateInvalid\] Failed to parse model "model_garbage"/,
  );
  assert.equal(cache.has("model_garbage"), false);
});

test("template sources: an unresolvable or unsupported resolution fails, and the next call can still succeed", async () => {
  const cache = new ModelTemplateCache();

  await assert.rejects(cache.resolveTemplate("model_a", resolverOf(undefined)), /could not be resolved/);
  await assert.rejects(
    cache.resolveTemplate("model_a", resolverOf(42)),
    /Unsupported asset resolution type for "model_a"/,
  );

  // A failed load must not leave a poisoned in-flight entry behind.
  const glb = await createSyntheticGlb({ size: [1, 1, 1] });
  const template = await cache.resolveTemplate("model_a", resolverOf(glb));
  assert.equal(cache.get("model_a"), template);
});

test("template sources: every failure carries a [model.cache.*] or [model.instance.*] code", async () => {
  const cache = new ModelTemplateCache();

  await assert.rejects(
    cache.resolveTemplate("model_none", resolverOf(undefined)),
    /^Error: \[model\.cache\.unresolved\] Asset "model_none" could not be resolved$/,
  );
  await assert.rejects(
    cache.resolveTemplate("model_num", resolverOf(42)),
    /^Error: \[model\.cache\.unsupportedSource\] Unsupported asset resolution type for "model_num"$/,
  );
  // "!" is not a base64 character: atob throws a bare InvalidCharacterError.
  await assert.rejects(
    cache.resolveTemplate("model_b64", resolverOf("data:model/gltf-binary;base64,!!!!")),
    /\[model\.cache\.sourceDecodeFailed\] Asset "model_b64" has an invalid base64 data URL/,
  );
  assert.equal(cache.has("model_b64"), false);
});

test("template sources: a loader that rejects is reported as loadFailed with the cause and is not cached", async () => {
  const cache = new ModelTemplateCache();
  const loader = {
    loadAsync: async () => {
      throw new Error("404 Not Found");
    },
  } as unknown as GLTFLoader;

  await assert.rejects(
    cache.resolveTemplate("model_404", resolverOf("https://example.test/missing.glb"), loader),
    /\[model\.cache\.loadFailed\] Failed to load model "model_404": 404 Not Found/,
  );
  assert.equal(cache.has("model_404"), false);
  assert.equal(cache.parseCount, 1, "the attempt is still counted as a parse");

  // A rejected non-Error value is stringified rather than lost.
  const stringLoader = {
    loadAsync: async () => {
      throw "boom";
    },
  } as unknown as GLTFLoader;
  await assert.rejects(
    cache.resolveTemplate("model_str", resolverOf("data:text/plain,x"), stringLoader),
    /\[model\.cache\.loadFailed\] Failed to load model "model_str": boom/,
  );
});

test("template sources: a failed URL load clears the in-flight entry so a retry can succeed", async () => {
  const cache = new ModelTemplateCache();
  const failing = {
    loadAsync: async () => {
      throw new Error("offline");
    },
  } as unknown as GLTFLoader;
  await assert.rejects(
    cache.resolveTemplate("model_retry", resolverOf("https://example.test/r.glb"), failing),
    /loadFailed/,
  );

  const ok = fakeLoader({ scene: true });
  const template = await cache.resolveTemplate(
    "model_retry",
    resolverOf("https://example.test/r.glb"),
    ok.loader,
  );
  assert.equal(cache.get("model_retry"), template);
});
