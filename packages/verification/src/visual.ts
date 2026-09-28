import { createHash } from "node:crypto";
import { PNG } from "pngjs";

export interface DecodedImage {
  width: number;
  height: number;
  data: Uint8Array; // Raw RGBA bytes (4 bytes per pixel)
}

export interface VisualFrameEvidence {
  sha256: string;
  width: number;
  height: number;
  meanLuminance: number; // 0..1 (average luminance across all pixels)
  luminanceVariance: number; // Variance of luminance across pixels
  entropy: number; // Shannon entropy over 256 luminance bins (0..8)
  perceptualHash: string; // 64-bit difference hash (16 hex chars)
  edgeDensity: number; // 0..1 ratio of Sobel edge pixels
  opaquePixelRatio: number; // 0..1 ratio of pixels with alpha >= 5%
}

export interface VisualSimilarityThresholds {
  maxChangedPixelRatio?: number | undefined; // Default 0.05 (5% changed pixels)
  maxPerceptualHashDistance?: number | undefined; // Default 8 (out of 64 bits)
  maxMeanAbsoluteDifference?: number | undefined; // Default 0.08
  pixelDiffThreshold?: number | undefined; // RGB absolute sum threshold (default 24)
}

export interface VisualComparison {
  width: number;
  height: number;
  perceptualHashDistance: number; // Hamming distance (0..64)
  changedPixelRatio: number; // Fraction of changed pixels (0..1)
  meanAbsoluteDifference: number; // Mean absolute luminance difference (0..1)
  similar: boolean; // True if within all configured thresholds
  details?: {
    pixelDiffThreshold?: number | undefined;
    maxChangedPixelRatio?: number | undefined;
    maxPerceptualHashDistance?: number | undefined;
    maxMeanAbsoluteDifference?: number | undefined;
  } | undefined;
}

export interface BlankFrameOptions {
  minOpaqueRatio?: number | undefined; // Default 0.5
  minLuminanceVariance?: number | undefined; // Default 0.0005
  minEntropy?: number | undefined; // Default 0.2
}

/**
 * Decodes PNG bytes into raw RGBA pixel data.
 */
export function decodePng(bytes: Uint8Array): DecodedImage {
  const parsed = PNG.sync.read(Buffer.from(bytes));
  return {
    width: parsed.width,
    height: parsed.height,
    data: new Uint8Array(parsed.data.buffer, parsed.data.byteOffset, parsed.data.byteLength),
  };
}

/**
 * Encodes raw RGBA pixel data into PNG bytes.
 */
export function encodePng(image: DecodedImage): Uint8Array {
  const png = new PNG({ width: image.width, height: image.height });
  png.data = Buffer.from(image.data);
  return new Uint8Array(PNG.sync.write(png));
}

/**
 * Computes difference hash (dHash 64-bit) from decoded RGBA image.
 * Uses a 9x8 grid of block-averaged luminance values.
 */
export function dHash(decoded: DecodedImage): string {
  const { width, height, data } = decoded;
  if (width === 0 || height === 0) {
    return "0000000000000000";
  }

  // 9 columns x 8 rows of block luminance
  const grid: number[][] = [];
  for (let r = 0; r < 8; r++) {
    const row: number[] = [];
    const y0 = Math.floor((r * height) / 8);
    const y1 = Math.max(y0 + 1, Math.floor(((r + 1) * height) / 8));

    for (let c = 0; c < 9; c++) {
      const x0 = Math.floor((c * width) / 9);
      const x1 = Math.max(x0 + 1, Math.floor(((c + 1) * width) / 9));

      let sumY = 0;
      let count = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const idx = (y * width + x) * 4;
          const red = data[idx] ?? 0;
          const green = data[idx + 1] ?? 0;
          const blue = data[idx + 2] ?? 0;
          sumY += (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255.0;
          count++;
        }
      }
      row.push(count > 0 ? sumY / count : 0);
    }
    grid.push(row);
  }

  // Compute 64 difference bits: bit is 1 if grid[r][c] > grid[r][c+1]
  const bits: number[] = [];
  for (let r = 0; r < 8; r++) {
    const row = grid[r]!;
    for (let c = 0; c < 8; c++) {
      bits.push((row[c] ?? 0) > (row[c + 1] ?? 0) ? 1 : 0);
    }
  }

  // Pack 64 bits into 16 hex characters
  let hex = "";
  for (let i = 0; i < 64; i += 4) {
    const nibble =
      ((bits[i] ?? 0) << 3) |
      ((bits[i + 1] ?? 0) << 2) |
      ((bits[i + 2] ?? 0) << 1) |
      (bits[i + 3] ?? 0);
    hex += nibble.toString(16);
  }
  return hex;
}

/**
 * Calculates Hamming distance (number of differing bits) between two 16-hex perceptual hashes.
 */
export function hammingDistance(hexA: string, hexB: string): number {
  if (hexA.length !== 16 || hexB.length !== 16) {
    // If lengths mismatch, compare common length and penalize
    let dist = Math.abs(hexA.length - hexB.length) * 4;
    const len = Math.min(hexA.length, hexB.length);
    for (let i = 0; i < len; i++) {
      const valA = parseInt(hexA[i] ?? "0", 16);
      const valB = parseInt(hexB[i] ?? "0", 16);
      let xor = valA ^ valB;
      while (xor > 0) {
        dist += xor & 1;
        xor >>= 1;
      }
    }
    return dist;
  }

  let dist = 0;
  for (let i = 0; i < 16; i++) {
    const valA = parseInt(hexA[i]!, 16);
    const valB = parseInt(hexB[i]!, 16);
    let xor = valA ^ valB;
    while (xor > 0) {
      dist += xor & 1;
      xor >>= 1;
    }
  }
  return dist;
}

/**
 * Analyzes PNG bytes and produces a deterministic VisualFrameEvidence record.
 */
export function calculateVisualEvidence(bytes: Uint8Array): VisualFrameEvidence {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const decoded = decodePng(bytes);
  const { width, height, data } = decoded;

  const totalPixels = width * height;
  if (totalPixels === 0) {
    return {
      sha256,
      width: 0,
      height: 0,
      meanLuminance: 0,
      luminanceVariance: 0,
      entropy: 0,
      perceptualHash: "0000000000000000",
      edgeDensity: 0,
      opaquePixelRatio: 0,
    };
  }

  const luminances = new Float32Array(totalPixels);
  const hist = new Uint32Array(256);
  let opaqueCount = 0;
  let sumLuminance = 0;

  for (let i = 0; i < totalPixels; i++) {
    const offset = i * 4;
    const red = data[offset] ?? 0;
    const green = data[offset + 1] ?? 0;
    const blue = data[offset + 2] ?? 0;
    const alpha = data[offset + 3] ?? 0;

    if (alpha >= 13) {
      opaqueCount++;
    }

    const lum = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255.0;
    luminances[i] = lum;
    sumLuminance += lum;

    const bin = Math.min(255, Math.max(0, Math.round(lum * 255)));
    hist[bin] = (hist[bin] ?? 0) + 1;
  }

  const meanLuminance = sumLuminance / totalPixels;

  // Variance
  let sumSqDiff = 0;
  for (let i = 0; i < totalPixels; i++) {
    const diff = (luminances[i] ?? 0) - meanLuminance;
    sumSqDiff += diff * diff;
  }
  const luminanceVariance = sumSqDiff / totalPixels;

  // Shannon Entropy
  let entropy = 0;
  for (let k = 0; k < 256; k++) {
    const count = hist[k] ?? 0;
    if (count > 0) {
      const p = count / totalPixels;
      entropy -= p * Math.log2(p);
    }
  }

  // Sobel Edge Density
  let edgeCount = 0;
  let interiorPixels = 0;
  if (width >= 3 && height >= 3) {
    interiorPixels = (width - 2) * (height - 2);
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const topRow = (y - 1) * width;
        const midRow = y * width;
        const botRow = (y + 1) * width;

        const p00 = luminances[topRow + x - 1] ?? 0;
        const p02 = luminances[topRow + x + 1] ?? 0;
        const p10 = luminances[midRow + x - 1] ?? 0;
        const p12 = luminances[midRow + x + 1] ?? 0;
        const p20 = luminances[botRow + x - 1] ?? 0;
        const p22 = luminances[botRow + x + 1] ?? 0;

        const p01 = luminances[topRow + x] ?? 0;
        const p21 = luminances[botRow + x] ?? 0;

        const gx = -p00 + p02 - 2 * p10 + 2 * p12 - p20 + p22;
        const gy = -p00 - 2 * p01 - p02 + p20 + 2 * p21 + p22;

        const mag = (Math.abs(gx) + Math.abs(gy)) / 4.0;
        if (mag > 0.12) {
          edgeCount++;
        }
      }
    }
  }
  const edgeDensity = interiorPixels > 0 ? edgeCount / interiorPixels : 0;

  // Perceptual hash
  const perceptualHash = dHash(decoded);

  return {
    sha256,
    width,
    height,
    meanLuminance: Number(meanLuminance.toFixed(5)),
    luminanceVariance: Number(luminanceVariance.toFixed(6)),
    entropy: Number(entropy.toFixed(4)),
    perceptualHash,
    edgeDensity: Number(edgeDensity.toFixed(5)),
    opaquePixelRatio: Number((opaqueCount / totalPixels).toFixed(4)),
  };
}

/**
 * Compares two decoded PNG image frames and calculates perceptual differences.
 */
export function compareVisualFrames(
  referenceBytes: Uint8Array,
  actualBytes: Uint8Array,
  options?: VisualSimilarityThresholds,
): VisualComparison {
  const refDecoded = decodePng(referenceBytes);
  const actualDecoded = decodePng(actualBytes);

  const refEvidence = calculateVisualEvidence(referenceBytes);
  const actualEvidence = calculateVisualEvidence(actualBytes);

  const hashDist = hammingDistance(refEvidence.perceptualHash, actualEvidence.perceptualHash);

  const pixelDiffThreshold = options?.pixelDiffThreshold ?? 24;
  const maxChangedPixelRatio = options?.maxChangedPixelRatio ?? 0.05;
  const maxPerceptualHashDistance = options?.maxPerceptualHashDistance ?? 8;
  const maxMeanAbsoluteDifference = options?.maxMeanAbsoluteDifference ?? 0.08;

  const minW = Math.min(refDecoded.width, actualDecoded.width);
  const minH = Math.min(refDecoded.height, actualDecoded.height);
  const maxW = Math.max(refDecoded.width, actualDecoded.width);
  const maxH = Math.max(refDecoded.height, actualDecoded.height);

  const totalComparedPixels = maxW * maxH;
  if (totalComparedPixels === 0) {
    return {
      width: 0,
      height: 0,
      perceptualHashDistance: 0,
      changedPixelRatio: 0,
      meanAbsoluteDifference: 0,
      similar: true,
    };
  }

  let changedPixels = 0;
  let sumAbsDiff = 0;

  for (let y = 0; y < minH; y++) {
    for (let x = 0; x < minW; x++) {
      const idxA = (y * refDecoded.width + x) * 4;
      const idxB = (y * actualDecoded.width + x) * 4;

      const rA = refDecoded.data[idxA] ?? 0;
      const gA = refDecoded.data[idxA + 1] ?? 0;
      const bA = refDecoded.data[idxA + 2] ?? 0;

      const rB = actualDecoded.data[idxB] ?? 0;
      const gB = actualDecoded.data[idxB + 1] ?? 0;
      const bB = actualDecoded.data[idxB + 2] ?? 0;

      const diff = Math.abs(rA - rB) + Math.abs(gA - gB) + Math.abs(bA - bB);
      if (diff > pixelDiffThreshold) {
        changedPixels++;
      }

      const lumA = (0.2126 * rA + 0.7152 * gA + 0.0722 * bA) / 255.0;
      const lumB = (0.2126 * rB + 0.7152 * gB + 0.0722 * bB) / 255.0;
      sumAbsDiff += Math.abs(lumA - lumB);
    }
  }

  // Account for non-overlapping area if dimensions differ
  const nonOverlap = totalComparedPixels - minW * minH;
  changedPixels += nonOverlap;
  sumAbsDiff += nonOverlap; // Assume maximum difference for missing pixels

  const changedPixelRatio = Number((changedPixels / totalComparedPixels).toFixed(4));
  const meanAbsoluteDifference = Number((sumAbsDiff / totalComparedPixels).toFixed(4));

  const similar =
    changedPixelRatio <= maxChangedPixelRatio &&
    hashDist <= maxPerceptualHashDistance &&
    meanAbsoluteDifference <= maxMeanAbsoluteDifference;

  return {
    width: actualDecoded.width,
    height: actualDecoded.height,
    perceptualHashDistance: hashDist,
    changedPixelRatio,
    meanAbsoluteDifference,
    similar,
    details: {
      pixelDiffThreshold,
      maxChangedPixelRatio,
      maxPerceptualHashDistance,
      maxMeanAbsoluteDifference,
    },
  };
}

/**
 * Detects whether a frame is blank, transparent, solid color, or severely broken.
 */
export function detectBlankFrame(
  evidence: VisualFrameEvidence,
  options?: BlankFrameOptions,
): { isBlank: boolean; reason?: string | undefined } {
  const minOpaqueRatio = options?.minOpaqueRatio ?? 0.5;
  const minLuminanceVariance = options?.minLuminanceVariance ?? 0.0005;
  const minEntropy = options?.minEntropy ?? 0.2;

  if (evidence.opaquePixelRatio < minOpaqueRatio) {
    return {
      isBlank: true,
      reason: `Frame is mostly transparent: opaque ratio ${evidence.opaquePixelRatio.toFixed(3)} < ${minOpaqueRatio}`,
    };
  }

  if (evidence.luminanceVariance < minLuminanceVariance) {
    if (evidence.meanLuminance < 0.02) {
      return {
        isBlank: true,
        reason: `Frame is solid black or near-black: mean luminance ${evidence.meanLuminance.toFixed(3)}, variance ${evidence.luminanceVariance.toFixed(6)}`,
      };
    }
    if (evidence.meanLuminance > 0.98) {
      return {
        isBlank: true,
        reason: `Frame is solid white: mean luminance ${evidence.meanLuminance.toFixed(3)}, variance ${evidence.luminanceVariance.toFixed(6)}`,
      };
    }
  }

  if (evidence.entropy < minEntropy) {
    return {
      isBlank: true,
      reason: `Frame has extremely low information entropy: ${evidence.entropy.toFixed(3)} < ${minEntropy}`,
    };
  }

  return { isBlank: false };
}
