import assert from "node:assert/strict";
import test from "node:test";

import { ikTargetOptions } from "../src/ik-target-options.js";

// Review follow-up #82 item 3: `animation.ik.setTarget` forwarded `weight` only when it was a number,
// so `weight: "0.5"` was dropped and IK ran at weight 1 instead of answering `ik.target.invalid-weight`.

test("a numeric weight and a pole are forwarded untouched", () => {
  assert.deepEqual(ikTargetOptions({ weight: 0.5, pole: [0, 1, 2] }), { weight: 0.5, pole: [0, 1, 2] });
});

test("a weight of the wrong type is forwarded so the controller can reject it", () => {
  assert.deepEqual(ikTargetOptions({ weight: "0.5" }), { weight: "0.5" });
  assert.deepEqual(ikTargetOptions({ weight: null }), { weight: null });
  assert.deepEqual(ikTargetOptions({ weight: Number.NaN }).weight, Number.NaN);
});

test("an absent weight or pole stays absent (explicit undefined counts as absent)", () => {
  assert.deepEqual(ikTargetOptions({}), {});
  assert.deepEqual(ikTargetOptions({ weight: undefined, pole: undefined }), {});
  assert.equal("weight" in ikTargetOptions({ weight: undefined }), false);
});
