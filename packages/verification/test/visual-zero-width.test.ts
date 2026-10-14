import assert from "node:assert/strict";
import test from "node:test";
import { deflateSync } from "node:zlib";
import {
  calculateVisualEvidence,
  compareVisualFrames,
  encodePng,
  type DecodedImage,
} from "../src/index.js";

// pngjs cannot *encode* an empty frame, but it can decode a hand-built PNG
// whose IHDR declares width 0. Those frames reach the zero-pixel guards in
// calculateVisualEvidence and compareVisualFrames, which no encodePng-based
// test can hit.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) {
    c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/**
 * A valid RGBA PNG declaring `width` x `height` where width is 0: every
 * scanline is just its filter-type byte (0 = None), so the stream is `height`
 * zero bytes. (An empty stream would leave pngjs reading uninitialised memory.)
 */
function emptyPng(width: number, height: number): Uint8Array {
  assert.equal(width, 0, "helper only builds zero-width frames");
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(Buffer.alloc(height))),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
}

function solid(width: number, height: number, gray: number): DecodedImage {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data.set([gray, gray, gray, 255], i * 4);
  }
  return { width, height, data };
}

test("a zero-width frame yields all-zero evidence with a zero hash instead of NaN", () => {
  const evidence = calculateVisualEvidence(emptyPng(0, 5));
  assert.equal(evidence.width, 0);
  assert.equal(evidence.height, 0);
  assert.equal(evidence.meanLuminance, 0);
  assert.equal(evidence.luminanceVariance, 0);
  assert.equal(evidence.entropy, 0);
  assert.equal(evidence.edgeDensity, 0);
  assert.equal(evidence.opaquePixelRatio, 0);
  assert.equal(evidence.perceptualHash, "0000000000000000");
  assert.match(evidence.sha256, /^[0-9a-f]{64}$/);
});

test("evidence of a zero-width frame is deterministic and keyed by its bytes", () => {
  const a = calculateVisualEvidence(emptyPng(0, 5));
  const b = calculateVisualEvidence(emptyPng(0, 5));
  const other = calculateVisualEvidence(emptyPng(0, 7));
  assert.deepEqual(a, b);
  assert.notEqual(a.sha256, other.sha256);
});

test("two zero-area frames compare as similar with a 0x0 result and no threshold details", () => {
  const comparison = compareVisualFrames(emptyPng(0, 5), emptyPng(0, 7));
  assert.deepEqual(comparison, {
    width: 0,
    height: 0,
    perceptualHashDistance: 0,
    changedPixelRatio: 0,
    meanAbsoluteDifference: 0,
    similar: true,
  });
});

test("a zero-area frame against a real frame is fully different, never silently similar", () => {
  const real = encodePng(solid(4, 4, 128));
  for (const [reference, actual] of [
    [emptyPng(0, 5), real],
    [real, emptyPng(0, 5)],
  ] as const) {
    const comparison = compareVisualFrames(reference, actual);
    assert.equal(comparison.changedPixelRatio, 1);
    assert.equal(comparison.meanAbsoluteDifference, 1);
    assert.equal(comparison.similar, false);
  }
});

test("invalid thresholds still fail fast when both frames are zero-area", () => {
  assert.throws(
    () => compareVisualFrames(emptyPng(0, 1), emptyPng(0, 1), { maxChangedPixelRatio: Number.NaN }),
    (error: unknown) => error instanceof Error && error.message.startsWith("visual.invalidThreshold"),
  );
});
