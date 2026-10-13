import assert from "node:assert/strict";
import test from "node:test";

import { type SkeletonProfile, computeRetargetCacheKey } from "../src/index.js";

const source: SkeletonProfile = { id: "src", bones: { hips: "SrcHips", spine: "SrcSpine" } };
const target: SkeletonProfile = { id: "tgt", bones: { hips: "Hips", spine: "Spine" } };

function key(extra: {
  settings?: Record<string, unknown>;
  sourceRestPoses?: Record<string, { rotation?: [number, number, number, number] }>;
}): string {
  return computeRetargetCacheKey({ sourceClipId: "walk", source, target, ...extra });
}

test("computeRetargetCacheKey tells NaN, Infinity, -Infinity and null settings apart", () => {
  const keys = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, null].map((scaleFactor) =>
    key({ settings: { scaleFactor } }),
  );
  assert.equal(new Set(keys).size, keys.length, "each of NaN / Infinity / -Infinity / null needs its own key");
});

test("computeRetargetCacheKey tells a non-finite rest pose value from null", () => {
  const withNaN = key({ sourceRestPoses: { SrcHips: { rotation: [Number.NaN, 0, 0, 1] } } });
  const withNull = key({ sourceRestPoses: { SrcHips: { rotation: [null as unknown as number, 0, 0, 1] } } });
  assert.notEqual(withNaN, withNull);
});

test("computeRetargetCacheKey keeps a __proto__ setting as data instead of dropping it", () => {
  const hostile = JSON.parse('{"__proto__":{"scaleFactor":2}}') as Record<string, unknown>;
  assert.notEqual(key({ settings: hostile }), key({ settings: {} }));
  const other = JSON.parse('{"__proto__":{"scaleFactor":3}}') as Record<string, unknown>;
  assert.notEqual(key({ settings: hostile }), key({ settings: other }));
});

test("computeRetargetCacheKey stays independent of settings key order and deterministic", () => {
  const first = key({ settings: { scaleFactor: 2, hipsTranslationPolicy: "scale" } });
  const second = key({ settings: { hipsTranslationPolicy: "scale", scaleFactor: 2 } });
  assert.equal(first, second);
  assert.match(first, /^[0-9a-f]{64}$/);
});
