import assert from "node:assert/strict";
import test from "node:test";
import { compareVisualFrames, encodePng } from "../src/index.js";

const WIDTH = 1000;
const HEIGHT = 100;

function frame(whitePixels: number): Uint8Array {
  const data = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let i = 0; i < WIDTH * HEIGHT; i++) {
    const v = i < whitePixels ? 255 : 0;
    data[i * 4] = v;
    data[i * 4 + 1] = v;
    data[i * 4 + 2] = v;
    data[i * 4 + 3] = 255;
  }
  return encodePng({ width: WIDTH, height: HEIGHT, data });
}

test("compareVisualFrames: 5.004% changed pixels exceed a 5% ratio limit (no rounding in the verdict)", () => {
  const result = compareVisualFrames(frame(0), frame(5004), {
    maxChangedPixelRatio: 0.05,
    maxPerceptualHashDistance: 64,
    maxMeanAbsoluteDifference: 1,
  });
  assert.equal(result.similar, false);
});

test("compareVisualFrames: 5.004% mean luminance difference exceeds a 0.05 limit (no rounding in the verdict)", () => {
  const result = compareVisualFrames(frame(0), frame(5004), {
    maxChangedPixelRatio: 1,
    maxPerceptualHashDistance: 64,
    maxMeanAbsoluteDifference: 0.05,
  });
  assert.equal(result.similar, false);
});

test("compareVisualFrames: exactly at the limits is still similar", () => {
  const result = compareVisualFrames(frame(0), frame(5000), {
    maxChangedPixelRatio: 0.05,
    maxPerceptualHashDistance: 64,
    maxMeanAbsoluteDifference: 0.05,
  });
  assert.equal(result.similar, true);
  assert.equal(result.changedPixelRatio, 0.05);
});
