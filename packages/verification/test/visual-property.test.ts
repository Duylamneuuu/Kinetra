import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateVisualEvidence,
  compareVisualFrames,
  dHash,
  decodePng,
  encodePng,
  hammingDistance,
  VisualError,
  type DecodedImage,
} from "../src/index.js";

// Seeded, dependency-free PRNG so every run explores the same cases.
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ITERATIONS = 200;

function randomInt(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

function randomHash(rng: () => number): string {
  let hex = "";
  for (let i = 0; i < 16; i++) {
    hex += randomInt(rng, 0, 15).toString(16);
  }
  return hex;
}

function randomImage(rng: () => number, width: number, height: number): DecodedImage {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i++) {
    data[i] = randomInt(rng, 0, 255);
  }
  return { width, height, data };
}

function solidImage(width: number, height: number, gray: number, alpha = 255): DecodedImage {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = gray;
    data[i * 4 + 1] = gray;
    data[i * 4 + 2] = gray;
    data[i * 4 + 3] = alpha;
  }
  return { width, height, data };
}

function popcount64(hexA: string, hexB: string): number {
  let xor = BigInt(`0x${hexA}`) ^ BigInt(`0x${hexB}`);
  let bits = 0;
  while (xor > 0n) {
    bits += Number(xor & 1n);
    xor >>= 1n;
  }
  return bits;
}

function assertVisualError(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof VisualError, `expected VisualError, got ${String(error)}`);
    assert.equal(error.code, code);
    assert.ok(error.message.startsWith(`${code}:`), error.message);
    return true;
  });
}

test("hammingDistance is a metric on 64-bit hashes and matches a BigInt popcount oracle", () => {
  const rng = mulberry32(0x5eed01);
  for (let i = 0; i < ITERATIONS; i++) {
    const a = randomHash(rng);
    const b = randomHash(rng);
    const c = randomHash(rng);
    const ab = hammingDistance(a, b);
    assert.equal(hammingDistance(a, a), 0, "identity");
    assert.equal(ab, hammingDistance(b, a), "symmetry");
    assert.ok(ab >= 0 && ab <= 64, `range: ${ab}`);
    assert.ok(ab <= hammingDistance(a, c) + hammingDistance(c, b), "triangle inequality");
    assert.equal(ab, popcount64(a, b), `oracle mismatch for ${a} vs ${b}`);
    assert.equal(hammingDistance(a.toUpperCase(), b), ab, "case-insensitive");
  }
});

test("hammingDistance rejects malformed hashes with a structured error (regression: NaN nibbles compared as equal)", () => {
  const valid = "0123456789abcdef";
  // Before the fix "zzzzzzzzzzzzzzzz" vs "0000000000000000" returned 0.
  for (const bad of ["", "0", "0123456789abcde", "0123456789abcdef0", "zzzzzzzzzzzzzzzz", "0123456789abcdeg", " 123456789abcdef", "0x23456789abcdef"]) {
    assertVisualError(() => hammingDistance(bad, valid), "visual.invalidPerceptualHash");
    assertVisualError(() => hammingDistance(valid, bad), "visual.invalidPerceptualHash");
  }
  assertVisualError(
    () => hammingDistance(undefined as unknown as string, valid),
    "visual.invalidPerceptualHash",
  );
});

test("dHash always yields 16 lowercase hex chars and is deterministic for arbitrary sizes", () => {
  const rng = mulberry32(0x5eed02);
  for (let i = 0; i < ITERATIONS; i++) {
    const image = randomImage(rng, randomInt(rng, 0, 40), randomInt(rng, 0, 40));
    const hash = dHash(image);
    assert.match(hash, /^[0-9a-f]{16}$/);
    assert.equal(dHash({ ...image, data: new Uint8Array(image.data) }), hash);
  }
});

test("dHash of any uniform image is all zeros, and of monotone gradients is all ones / all zeros", () => {
  const rng = mulberry32(0x5eed03);
  for (let i = 0; i < 50; i++) {
    const image = solidImage(randomInt(rng, 1, 48), randomInt(rng, 1, 48), randomInt(rng, 0, 255));
    assert.equal(dHash(image), "0000000000000000");
  }

  for (const scale of [1, 2, 3]) {
    const width = 18 * scale;
    const height = 8 * scale;
    const decreasing = solidImage(width, height, 0);
    const increasing = solidImage(width, height, 0);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const column = Math.floor(x / scale);
        const idx = (y * width + x) * 4;
        decreasing.data.fill(255 - column * 14, idx, idx + 3);
        increasing.data.fill(column * 14, idx, idx + 3);
      }
    }
    assert.equal(dHash(decreasing), "ffffffffffffffff", `decreasing gradient at scale ${scale}`);
    assert.equal(dHash(increasing), "0000000000000000", `increasing gradient at scale ${scale}`);
  }
});

test("dHash and encodePng reject RGBA buffers that do not match width*height*4", () => {
  const cases: DecodedImage[] = [
    { width: 2, height: 2, data: new Uint8Array(15) },
    { width: 2, height: 2, data: new Uint8Array(17) },
    { width: -1, height: 2, data: new Uint8Array(0) },
    { width: 1.5, height: 2, data: new Uint8Array(12) },
    { width: Number.NaN, height: 1, data: new Uint8Array(4) },
    { width: 1, height: 1, data: [0, 0, 0, 255] as unknown as Uint8Array },
  ];
  for (const image of cases) {
    assertVisualError(() => dHash(image), "visual.invalidImage");
    assertVisualError(() => encodePng(image), "visual.invalidImage");
  }
});

test("decodePng wraps unreadable bytes in visual.decodeFailed", () => {
  const rng = mulberry32(0x5eed04);
  const valid = encodePng(solidImage(4, 4, 128));
  const inputs: Uint8Array[] = [
    new Uint8Array(0),
    new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    valid.slice(0, valid.byteLength - 20),
  ];
  for (let i = 0; i < 20; i++) {
    const noise = new Uint8Array(randomInt(rng, 1, 64));
    for (let j = 0; j < noise.length; j++) noise[j] = randomInt(rng, 0, 255);
    inputs.push(noise);
  }
  for (const bytes of inputs) {
    assertVisualError(() => decodePng(bytes), "visual.decodeFailed");
  }
});

test("encodePng/decodePng round-trip arbitrary RGBA images bit-exactly", () => {
  const rng = mulberry32(0x5eed05);
  for (let i = 0; i < 60; i++) {
    const image = randomImage(rng, randomInt(rng, 1, 24), randomInt(rng, 1, 24));
    const decoded = decodePng(encodePng(image));
    assert.equal(decoded.width, image.width);
    assert.equal(decoded.height, image.height);
    assert.deepEqual(Array.from(decoded.data), Array.from(image.data));
  }
});

test("calculateVisualEvidence fields stay inside their documented ranges", () => {
  const rng = mulberry32(0x5eed06);
  for (let i = 0; i < 80; i++) {
    const image = randomImage(rng, randomInt(rng, 1, 32), randomInt(rng, 1, 32));
    const evidence = calculateVisualEvidence(encodePng(image));
    assert.equal(evidence.width, image.width);
    assert.equal(evidence.height, image.height);
    assert.match(evidence.sha256, /^[0-9a-f]{64}$/);
    assert.equal(evidence.perceptualHash, dHash(image));
    assert.ok(evidence.meanLuminance >= 0 && evidence.meanLuminance <= 1, `mean ${evidence.meanLuminance}`);
    assert.ok(evidence.luminanceVariance >= 0 && evidence.luminanceVariance <= 0.25, `var ${evidence.luminanceVariance}`);
    assert.ok(evidence.entropy >= 0 && evidence.entropy <= 8, `entropy ${evidence.entropy}`);
    assert.ok(evidence.edgeDensity >= 0 && evidence.edgeDensity <= 1, `edges ${evidence.edgeDensity}`);
    assert.ok(evidence.opaquePixelRatio >= 0 && evidence.opaquePixelRatio <= 1, `opaque ${evidence.opaquePixelRatio}`);
  }
});

test("compareVisualFrames: self-comparison is exact, same-size comparison is symmetric and bounded", () => {
  const rng = mulberry32(0x5eed07);
  for (let i = 0; i < 60; i++) {
    const width = randomInt(rng, 1, 32);
    const height = randomInt(rng, 1, 32);
    const a = encodePng(randomImage(rng, width, height));
    const b = encodePng(randomImage(rng, width, height));

    const self = compareVisualFrames(a, a);
    assert.equal(self.similar, true);
    assert.equal(self.changedPixelRatio, 0);
    assert.equal(self.meanAbsoluteDifference, 0);
    assert.equal(self.perceptualHashDistance, 0);

    const ab = compareVisualFrames(a, b);
    const ba = compareVisualFrames(b, a);
    assert.equal(ab.changedPixelRatio, ba.changedPixelRatio);
    assert.equal(ab.meanAbsoluteDifference, ba.meanAbsoluteDifference);
    assert.equal(ab.perceptualHashDistance, ba.perceptualHashDistance);
    assert.equal(ab.similar, ba.similar);
    assert.ok(ab.changedPixelRatio >= 0 && ab.changedPixelRatio <= 1);
    assert.ok(ab.meanAbsoluteDifference >= 0 && ab.meanAbsoluteDifference <= 1);

    // Decoding once must not change the hash distance the evidence path reports.
    assert.equal(
      ab.perceptualHashDistance,
      hammingDistance(calculateVisualEvidence(a).perceptualHash, calculateVisualEvidence(b).perceptualHash),
    );
  }
});

test("compareVisualFrames counts every non-overlapping pixel as changed when sizes differ", () => {
  const small = encodePng(solidImage(4, 4, 100));
  const large = encodePng(solidImage(8, 4, 100));
  const comparison = compareVisualFrames(small, large);
  assert.equal(comparison.changedPixelRatio, 0.5);
  assert.equal(comparison.meanAbsoluteDifference, 0.5);
  assert.equal(comparison.similar, false);
  assert.equal(comparison.width, 8);
});

test("compareVisualFrames rejects out-of-range thresholds before decoding (regression: NaN made every frame dissimilar)", () => {
  const frame = encodePng(solidImage(4, 4, 100));
  const notPng = new Uint8Array([1, 2, 3]);
  const bad: Array<Record<string, number>> = [
    { maxChangedPixelRatio: Number.NaN },
    { maxChangedPixelRatio: -0.1 },
    { maxChangedPixelRatio: 1.5 },
    { maxPerceptualHashDistance: 65 },
    { maxPerceptualHashDistance: Number.POSITIVE_INFINITY },
    { maxMeanAbsoluteDifference: 2 },
    { pixelDiffThreshold: -1 },
    { pixelDiffThreshold: 766 },
  ];
  for (const options of bad) {
    assertVisualError(() => compareVisualFrames(frame, frame, options), "visual.invalidThreshold");
    // Threshold validation happens first, even when the frames are unreadable.
    assertVisualError(() => compareVisualFrames(notPng, notPng, options), "visual.invalidThreshold");
  }
  // Boundary values are accepted.
  const edge = compareVisualFrames(frame, frame, {
    maxChangedPixelRatio: 0,
    maxPerceptualHashDistance: 0,
    maxMeanAbsoluteDifference: 0,
    pixelDiffThreshold: 0,
  });
  assert.equal(edge.similar, true);
  assertVisualError(() => compareVisualFrames(notPng, frame), "visual.decodeFailed");
});
