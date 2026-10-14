import assert from "node:assert/strict";
import test from "node:test";

import { detectBlankFrame, VisualError, type VisualFrameEvidence } from "../src/visual.js";

const blackFrame: VisualFrameEvidence = {
  sha256: "0".repeat(64),
  width: 4,
  height: 4,
  meanLuminance: 0,
  luminanceVariance: 0,
  entropy: 0,
  perceptualHash: "0000000000000000",
  edgeDensity: 0,
  opaquePixelRatio: 1,
};

test("detectBlankFrame still flags a solid black frame with default thresholds", () => {
  assert.equal(detectBlankFrame(blackFrame).isBlank, true);
});

test("detectBlankFrame rejects NaN/out-of-range thresholds instead of calling the frame non-blank", () => {
  const bad: Array<Record<string, number>> = [
    { minOpaqueRatio: Number.NaN },
    { minLuminanceVariance: Number.NaN },
    { minEntropy: Number.NaN },
    { minEntropy: -1 },
    { minOpaqueRatio: Number.POSITIVE_INFINITY },
  ];
  for (const options of bad) {
    // Every `<` against NaN is false, so a NaN threshold used to switch its check off silently.
    assert.throws(
      () => detectBlankFrame(blackFrame, options),
      (error: unknown) =>
        error instanceof VisualError && error.code === "visual.invalidThreshold",
      JSON.stringify(options),
    );
  }
});

test("a NaN minEntropy no longer lets a zero-entropy frame through", () => {
  const flat: VisualFrameEvidence = {
    ...blackFrame,
    meanLuminance: 0.5,
    luminanceVariance: 0.01,
    entropy: 0,
  };
  assert.equal(detectBlankFrame(flat).isBlank, true, "default minEntropy flags it");
  assert.throws(() => detectBlankFrame(flat, { minEntropy: Number.NaN }), VisualError);
});
