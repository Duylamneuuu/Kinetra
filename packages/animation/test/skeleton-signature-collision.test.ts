import assert from "node:assert/strict";
import test from "node:test";

import { retargetCacheKey, skeletonSignature, type SkeletonProfile } from "../src/skeleton.js";

const profile = (bones: Record<string, string>): SkeletonProfile =>
  ({ id: "p", bones }) as unknown as SkeletonProfile;

test("skeletonSignature: a bone name with a newline cannot impersonate two mappings", () => {
  const forged = profile({ hips: "x\nspine=y" });
  const honest = profile({ hips: "x", spine: "y" });
  assert.notEqual(skeletonSignature(forged), skeletonSignature(honest));
});

test("skeletonSignature: a separator inside a semantic key cannot impersonate another mapping", () => {
  assert.notEqual(
    skeletonSignature(profile({ "hips=x": "y" })),
    skeletonSignature(profile({ hips: "x=y" })),
  );
});

test("skeletonSignature: ordinary profiles keep their historical canonical text", async () => {
  const { createHash } = await import("node:crypto");
  const expected = createHash("sha256").update("head=Head\nhips=Hips").digest("hex");
  assert.equal(skeletonSignature(profile({ hips: "Hips", head: "Head" })), expected);
});

test("skeletonSignature: still independent of key order and of the profile id", () => {
  assert.equal(
    skeletonSignature(profile({ hips: "a\nb", head: "c" })),
    skeletonSignature({ id: "other", bones: { head: "c", hips: "a\nb" } } as unknown as SkeletonProfile),
  );
});

const key = (settings: Record<string, unknown>): string =>
  retargetCacheKey({ sourceClipId: "clip", source: profile({ hips: "a" }), target: profile({ hips: "b" }), settings });

test("retargetCacheKey: non-finite numbers do not collide with null", () => {
  assert.notEqual(key({ scale: Number.NaN }), key({ scale: null }));
  assert.notEqual(key({ scale: Number.POSITIVE_INFINITY }), key({ scale: Number.NEGATIVE_INFINITY }));
  assert.notEqual(key({ scale: Number.NaN }), key({ scale: Number.POSITIVE_INFINITY }));
});

test("retargetCacheKey: a JSON-parsed __proto__ setting changes the key", () => {
  const withProto = JSON.parse('{"__proto__":{"mode":"fast"}}') as Record<string, unknown>;
  assert.notEqual(key(withProto), key({}));
  const other = JSON.parse('{"__proto__":{"mode":"slow"}}') as Record<string, unknown>;
  assert.notEqual(key(withProto), key(other));
});

test("retargetCacheKey: stays stable across key order", () => {
  assert.equal(key({ a: 1, b: { c: 2, d: 3 } }), key({ b: { d: 3, c: 2 }, a: 1 }));
});
