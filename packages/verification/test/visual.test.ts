import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateVisualEvidence,
  compareVisualFrames,
  decodePng,
  detectBlankFrame,
  encodePng,
  hammingDistance,
  type DecodedImage,
} from "../src/index.js";

function createSolidRgba(
  width: number,
  height: number,
  r: number,
  g: number,
  b: number,
  a: number,
): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const idx = i * 4;
    data[idx] = r;
    data[idx + 1] = g;
    data[idx + 2] = b;
    data[idx + 3] = a;
  }
  return encodePng({ width, height, data });
}

function createPatternRgba(width: number, height: number): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      // Checkerboard with high-contrast gradient
      const isChecker = (Math.floor(x / 8) + Math.floor(y / 8)) % 2 === 0;
      const base = isChecker ? 220 : 30;
      data[idx] = (base + x * 2) % 256;
      data[idx + 1] = (base + y * 3) % 256;
      data[idx + 2] = (base + (x + y)) % 256;
      data[idx + 3] = 255;
    }
  }
  return encodePng({ width, height, data });
}

test("decodePng and encodePng round-trip correctly", () => {
  const originalData = new Uint8Array([
    255, 0, 0, 255,   0, 255, 0, 255,
    0, 0, 255, 255,   255, 255, 255, 255,
  ]);
  const image: DecodedImage = { width: 2, height: 2, data: originalData };
  const encoded = encodePng(image);
  assert.ok(encoded.byteLength > 20, "Encoded PNG must have valid byte length");

  const decoded = decodePng(encoded);
  assert.equal(decoded.width, 2);
  assert.equal(decoded.height, 2);
  assert.deepEqual(Array.from(decoded.data), Array.from(originalData));
});

test("calculateVisualEvidence produces deterministic evidence", () => {
  const pattern = createPatternRgba(64, 64);
  const evidence1 = calculateVisualEvidence(pattern);
  const evidence2 = calculateVisualEvidence(pattern);

  assert.equal(evidence1.sha256, evidence2.sha256);
  assert.equal(evidence1.width, 64);
  assert.equal(evidence1.height, 64);
  assert.equal(evidence1.meanLuminance, evidence2.meanLuminance);
  assert.equal(evidence1.luminanceVariance, evidence2.luminanceVariance);
  assert.equal(evidence1.entropy, evidence2.entropy);
  assert.equal(evidence1.perceptualHash, evidence2.perceptualHash);
  assert.equal(evidence1.edgeDensity, evidence2.edgeDensity);
  assert.equal(evidence1.opaquePixelRatio, 1.0);
  assert.ok(evidence1.entropy > 4.0, `Pattern entropy should be rich (> 4.0), got ${evidence1.entropy}`);
  assert.ok(evidence1.edgeDensity > 0.05, `Pattern edge density should be > 0.05, got ${evidence1.edgeDensity}`);
});

test("detectBlankFrame catches solid black, white, transparent, and low-entropy frames", () => {
  const black = createSolidRgba(32, 32, 0, 0, 0, 255);
  const blackEv = calculateVisualEvidence(black);
  assert.equal(blackEv.meanLuminance, 0);
  assert.equal(blackEv.luminanceVariance, 0);
  assert.equal(blackEv.entropy, 0);
  const blackCheck = detectBlankFrame(blackEv);
  assert.equal(blackCheck.isBlank, true);
  assert.ok(blackCheck.reason?.includes("solid black"));

  const white = createSolidRgba(32, 32, 255, 255, 255, 255);
  const whiteEv = calculateVisualEvidence(white);
  assert.equal(whiteEv.meanLuminance, 1.0);
  assert.equal(whiteEv.luminanceVariance, 0);
  assert.equal(whiteEv.entropy, 0);
  const whiteCheck = detectBlankFrame(whiteEv);
  assert.equal(whiteCheck.isBlank, true);
  assert.ok(whiteCheck.reason?.includes("solid white"));

  const transparent = createSolidRgba(32, 32, 100, 100, 100, 0);
  const transparentEv = calculateVisualEvidence(transparent);
  assert.equal(transparentEv.opaquePixelRatio, 0);
  const transCheck = detectBlankFrame(transparentEv);
  assert.equal(transCheck.isBlank, true);
  assert.ok(transCheck.reason?.includes("transparent"));

  const pattern = createPatternRgba(64, 64);
  const patternEv = calculateVisualEvidence(pattern);
  const patternCheck = detectBlankFrame(patternEv);
  assert.equal(patternCheck.isBlank, false);
});

test("hammingDistance correctly counts bit differences", () => {
  assert.equal(hammingDistance("0000000000000000", "0000000000000000"), 0);
  assert.equal(hammingDistance("0000000000000001", "0000000000000000"), 1);
  assert.equal(hammingDistance("000000000000000f", "0000000000000000"), 4);
  assert.equal(hammingDistance("ffffffffffffffff", "0000000000000000"), 64);
  assert.equal(hammingDistance("1234567890abcdef", "1234567890abcdef"), 0);
});

test("compareVisualFrames differentiates identical, subtle noisy, and distinct scenes", () => {
  const patternA = createPatternRgba(64, 64);
  const identicalComparison = compareVisualFrames(patternA, patternA);
  assert.equal(identicalComparison.similar, true);
  assert.equal(identicalComparison.changedPixelRatio, 0);
  assert.equal(identicalComparison.perceptualHashDistance, 0);

  // Subtle noise (only a couple pixels shifted slightly below diff threshold)
  const decodedA = decodePng(patternA);
  const subtleData = new Uint8Array(decodedA.data);
  subtleData[0] = Math.min(255, (subtleData[0] ?? 0) + 10);
  subtleData[1] = Math.min(255, (subtleData[1] ?? 0) + 5);
  const patternSubtle = encodePng({ width: 64, height: 64, data: subtleData });

  const subtleComparison = compareVisualFrames(patternA, patternSubtle, {
    maxChangedPixelRatio: 0.05,
    maxPerceptualHashDistance: 4,
  });
  assert.equal(subtleComparison.similar, true);
  assert.ok(subtleComparison.changedPixelRatio <= 0.01);
  assert.equal(subtleComparison.perceptualHashDistance, 0);

  // Materially different scene (black vs pattern)
  const black = createSolidRgba(64, 64, 0, 0, 0, 255);
  const diffComparison = compareVisualFrames(patternA, black);
  assert.equal(diffComparison.similar, false);
  assert.ok(diffComparison.changedPixelRatio > 0.5, `changedPixelRatio should be large, got ${diffComparison.changedPixelRatio}`);
  assert.ok(diffComparison.perceptualHashDistance > 10, `hash distance should be large, got ${diffComparison.perceptualHashDistance}`);
});
