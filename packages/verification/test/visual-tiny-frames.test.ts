import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateVisualEvidence,
  compareVisualFrames,
  decodePng,
  dHash,
  encodePng,
  VisualError,
  type DecodedImage,
} from "../src/index.js";

const ZERO_HASH = "0000000000000000";

function pixels(width: number, height: number, fn: (x: number, y: number) => [number, number, number, number]): DecodedImage {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = fn(x, y);
      const idx = (y * width + x) * 4;
      data[idx] = r;
      data[idx + 1] = g;
      data[idx + 2] = b;
      data[idx + 3] = a;
    }
  }
  return { width, height, data };
}

function solid(width: number, height: number, gray: number): DecodedImage {
  return pixels(width, height, () => [gray, gray, gray, 255]);
}

test("a 1x1 frame yields complete, finite evidence with no edges and a zero hash", () => {
  const evidence = calculateVisualEvidence(encodePng(solid(1, 1, 255)));
  assert.equal(evidence.width, 1);
  assert.equal(evidence.height, 1);
  assert.equal(evidence.meanLuminance, 1);
  assert.equal(evidence.luminanceVariance, 0);
  assert.equal(evidence.entropy, 0);
  assert.equal(evidence.edgeDensity, 0);
  assert.equal(evidence.opaquePixelRatio, 1);
  assert.equal(evidence.perceptualHash, ZERO_HASH);
});

test("frames narrower or shorter than 3 px have no Sobel interior, so edgeDensity is 0 even for hard contrast", () => {
  const stripes = (x: number) => (x % 2 === 0 ? 0 : 255);
  for (const [width, height] of [
    [2, 2],
    [2, 9],
    [9, 2],
    [1, 9],
    [9, 1],
  ] as const) {
    const evidence = calculateVisualEvidence(encodePng(pixels(width, height, (x) => [stripes(x), stripes(x), stripes(x), 255])));
    assert.equal(evidence.edgeDensity, 0, `${width}x${height}`);
    assert.ok(Number.isFinite(evidence.entropy), `${width}x${height} entropy finite`);
    assert.ok(evidence.perceptualHash.length === 16, `${width}x${height} hash has 16 hex chars`);
  }
});

test("a 3x3 frame has exactly one Sobel interior pixel: a vertical edge counts, a lone centre pixel does not", () => {
  const verticalEdge = calculateVisualEvidence(encodePng(pixels(3, 3, (x) => (x === 2 ? [255, 255, 255, 255] : [0, 0, 0, 255]))));
  assert.equal(verticalEdge.edgeDensity, 1);

  const centreOnly = calculateVisualEvidence(
    encodePng(pixels(3, 3, (x, y) => (x === 1 && y === 1 ? [255, 255, 255, 255] : [0, 0, 0, 255]))),
  );
  // The Sobel kernels ignore the centre sample, so it is not an edge.
  assert.equal(centreOnly.edgeDensity, 0);
  assert.ok(centreOnly.luminanceVariance > 0, "variance still sees the bright pixel");
});

test("opaque ratio counts alpha >= 13 (5%) as opaque and alpha 12 as transparent", () => {
  const evidence = calculateVisualEvidence(
    encodePng(pixels(4, 1, (x) => [90, 90, 90, [12, 13, 0, 255][x] ?? 0])),
  );
  // 13 and 255 are opaque; 12 and 0 are not.
  assert.equal(evidence.opaquePixelRatio, 0.5);
});

test("zero-area images are accepted by dHash and hash to zero", () => {
  for (const [width, height] of [
    [0, 0],
    [0, 5],
    [5, 0],
  ] as const) {
    assert.equal(dHash({ width, height, data: new Uint8Array(0) }), ZERO_HASH, `${width}x${height}`);
  }
});

test("malformed decoded images are rejected with visual.invalidImage before any pixel is read", () => {
  const bad: Array<[string, DecodedImage]> = [
    ["fractional width", { width: 1.5, height: 2, data: new Uint8Array(12) }],
    ["negative height", { width: 2, height: -1, data: new Uint8Array(0) }],
    ["NaN width", { width: Number.NaN, height: 1, data: new Uint8Array(4) }],
    ["short data", { width: 2, height: 2, data: new Uint8Array(15) }],
    ["long data", { width: 1, height: 1, data: new Uint8Array(5) }],
    ["non-Uint8Array data", { width: 1, height: 1, data: [0, 0, 0, 255] as unknown as Uint8Array }],
  ];
  for (const [label, image] of bad) {
    for (const call of [() => dHash(image), () => encodePng(image)]) {
      assert.throws(
        call,
        (error: unknown) => error instanceof VisualError && error.code === "visual.invalidImage",
        label,
      );
    }
  }
});

test("compareVisualFrames charges the non-overlapping area as fully changed when sizes differ", () => {
  const small = encodePng(solid(4, 4, 128));
  const large = encodePng(solid(8, 8, 128));

  const grow = compareVisualFrames(small, large);
  // 16 of 64 pixels overlap and match; the other 48 count as changed.
  assert.equal(grow.changedPixelRatio, 0.75);
  assert.equal(grow.meanAbsoluteDifference, 0.75);
  assert.equal(grow.similar, false);
  assert.equal(grow.width, 8, "reports the actual frame's size");
  assert.equal(grow.height, 8);

  const shrink = compareVisualFrames(large, small);
  assert.equal(shrink.changedPixelRatio, 0.75, "the penalty is symmetric");
  assert.equal(shrink.width, 4);
  assert.equal(shrink.height, 4);

  const lenient = compareVisualFrames(small, large, { maxChangedPixelRatio: 1, maxMeanAbsoluteDifference: 1 });
  assert.equal(lenient.similar, true, "explicit thresholds can still accept a size mismatch");
});

test("a differing aspect ratio is penalised even when the overlap is identical", () => {
  const wide = encodePng(solid(8, 2, 40));
  const tall = encodePng(solid(2, 8, 40));
  const result = compareVisualFrames(wide, tall);
  // Union is 8x8 = 64, overlap is 2x2 = 4 -> 60 pixels changed.
  assert.equal(result.changedPixelRatio, Number((60 / 64).toFixed(4)));
  assert.equal(result.similar, false);
});

test("decodePng rejects a truncated PNG with visual.decodeFailed and the byte length", () => {
  const full = encodePng(solid(4, 4, 200));
  const truncated = full.slice(0, Math.floor(full.byteLength / 2));
  assert.throws(
    () => decodePng(truncated),
    (error: unknown) =>
      error instanceof VisualError &&
      error.code === "visual.decodeFailed" &&
      error.details["byteLength"] === truncated.byteLength,
  );
});
