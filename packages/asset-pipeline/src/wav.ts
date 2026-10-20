import type { AssetDiagnostic, AssetMetadata } from "./types.js";
import type { AssetImporter, AssetImporterContext, AssetImporterResult } from "./reimport.js";

/** KSDATAFORMAT_SUBTYPE_PCM, little-endian, inside a WAVE_FORMAT_EXTENSIBLE `fmt ` chunk. */
const WAV_SUBFORMAT_PCM_GUID = new Uint8Array([
  0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71,
]);
const WAVE_FORMAT_PCM = 1;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;

export type WavImportErrorCode =
  | "asset.wav.notRiff"
  | "asset.wav.truncated"
  | "asset.wav.notPcm"
  | "asset.wav.invalidFmt"
  | "asset.wav.emptyData"
  | "asset.wav.missingFmt"
  | "asset.wav.missingData";

/**
 * A WAV the importer refused. `code` is copied onto the reimport result as `errorCode`.
 * The message starts with `[code]` and ends with `remediation`.
 */
export class WavImportError extends Error {
  readonly code: WavImportErrorCode;
  readonly remediation: string;

  constructor(code: WavImportErrorCode, message: string, remediation: string) {
    super(`[${code}] ${message} ${remediation}`);
    this.name = "WavImportError";
    this.code = code;
    this.remediation = remediation;
  }
}

export interface WavInfo {
  readonly sampleRate: number;
  readonly channels: number;
  readonly bitsPerSample: number;
  readonly dataBytes: number;
  /** Complete PCM frames divided by `sampleRate`. A trailing partial frame is not counted. */
  readonly durationSeconds: number;
}

function fail(code: WavImportErrorCode, message: string, remediation: string): never {
  throw new WavImportError(code, message, remediation);
}

function fourcc(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!);
}

function sameBytes(bytes: Uint8Array, offset: number, expected: Uint8Array): boolean {
  for (let index = 0; index < expected.length; index += 1) {
    if (bytes[offset + index] !== expected[index]) return false;
  }
  return true;
}

/**
 * Reads an integer-PCM RIFF/WAVE file. Chunks may appear in any order and may
 * be padded. `WAVE_FORMAT_EXTENSIBLE` is accepted when its sub-format GUID is
 * integer PCM. Throws `WavImportError` for a bad header, a truncated chunk, a
 * non-PCM format, an empty `data` chunk, or a `fmt ` the player cannot time.
 */
export function inspectWav(bytes: Uint8Array, assetId = "audio"): WavInfo {
  const label = `Audio asset "${assetId}"`;
  if (bytes.byteLength < 12) {
    fail(
      "asset.wav.truncated",
      `${label} has a truncated WAV header.`,
      "Re-export the file. A PCM WAV starts with a 12-byte RIFF/WAVE header.",
    );
  }
  if (fourcc(bytes, 0) !== "RIFF" || fourcc(bytes, 8) !== "WAVE") {
    fail(
      "asset.wav.notRiff",
      `${label} is not a RIFF/WAVE file.`,
      "Export integer PCM WAV. Other containers are not imported as audio.",
    );
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let format: { sampleRate: number; channels: number; bitsPerSample: number } | undefined;
  let dataBytes: number | undefined;
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const id = fourcc(bytes, offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (size > bytes.byteLength - body) {
      const which = id === "data" ? "data" : id === "fmt " ? "fmt" : id.trim() || "unknown";
      fail(
        "asset.wav.truncated",
        `${label} has a truncated ${which} chunk.`,
        "Re-export the WAV. A chunk claims more bytes than the file contains.",
      );
    }
    if (id === "fmt ") {
      if (size < 16) {
        fail(
          "asset.wav.truncated",
          `${label} has a truncated fmt chunk.`,
          "Re-export the WAV. The fmt chunk must be at least 16 bytes.",
        );
      }
      const formatTag = view.getUint16(body, true);
      if (formatTag === WAVE_FORMAT_EXTENSIBLE) {
        if (size < 40) {
          fail(
            "asset.wav.truncated",
            `${label} has a truncated WAVE_FORMAT_EXTENSIBLE fmt chunk.`,
            "Re-export the WAV. An extensible fmt chunk is 40 bytes.",
          );
        }
        if (!sameBytes(bytes, body + 24, WAV_SUBFORMAT_PCM_GUID)) {
          fail(
            "asset.wav.notPcm",
            `${label} is not PCM WAV (extensible sub-format tag ${view.getUint16(body + 24, true)}).`,
            "Export integer PCM. Float, ADPCM and compressed WAV are rejected.",
          );
        }
      } else if (formatTag !== WAVE_FORMAT_PCM) {
        fail(
          "asset.wav.notPcm",
          `${label} is not PCM WAV (format tag ${formatTag}).`,
          "Export integer PCM. Float, ADPCM and compressed WAV are rejected.",
        );
      }
      const channels = view.getUint16(body + 2, true);
      const sampleRate = view.getUint32(body + 4, true);
      const bitsPerSample = view.getUint16(body + 14, true);
      if (channels < 1 || sampleRate < 1 || bitsPerSample < 8 || bitsPerSample % 8 !== 0) {
        fail(
          "asset.wav.invalidFmt",
          `${label} has an invalid fmt chunk (channels ${channels}, ${sampleRate} Hz, ${bitsPerSample} bits).`,
          "Use at least one channel, a positive sample rate and a whole-byte bit depth (8, 16, 24 or 32).",
        );
      }
      format = { sampleRate, channels, bitsPerSample };
    } else if (id === "data") {
      if (size === 0) {
        fail(
          "asset.wav.emptyData",
          `${label} has an empty data chunk.`,
          "The data chunk must contain at least one byte of PCM.",
        );
      }
      dataBytes = size;
    }
    if (format && dataBytes !== undefined) break;
    offset = body + size + (size % 2);
  }
  if (!format) {
    fail(
      "asset.wav.missingFmt",
      `${label} has no fmt chunk.`,
      "Add an integer-PCM fmt chunk.",
    );
  }
  if (dataBytes === undefined) {
    fail(
      "asset.wav.missingData",
      `${label} has no data chunk.`,
      "Add a data chunk with the PCM samples.",
    );
  }
  const frameBytes = format.channels * (format.bitsPerSample >> 3);
  const frames = Math.floor(dataBytes / frameBytes);
  return {
    sampleRate: format.sampleRate,
    channels: format.channels,
    bitsPerSample: format.bitsPerSample,
    dataBytes,
    durationSeconds: frames / format.sampleRate,
  };
}

function recipeSampleRate(settings: Record<string, unknown>): number | undefined {
  const value = settings.sampleRate ?? settings.sampleRateHz;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Built-in audio importer (`wav` and `audio`). Copies the source bytes and
 * records `sampleRate`, `channels` and `durationSeconds`. A recipe sample rate
 * that disagrees with the file is a warning; the file's rate is what is stored.
 * Metadata the importer does not set is left on the record by reimport.
 */
export class WavImporter implements AssetImporter {
  async import(context: AssetImporterContext): Promise<AssetImporterResult> {
    const info = inspectWav(context.sourceBytes, context.assetId);
    const metadata: Partial<AssetMetadata> = {
      sampleRate: info.sampleRate,
      channels: info.channels,
      durationSeconds: info.durationSeconds,
    };
    const expected = recipeSampleRate(context.recipe.settings);
    const diagnostics: AssetDiagnostic[] = [];
    if (expected !== undefined && expected !== info.sampleRate) {
      diagnostics.push({
        severity: "warning",
        code: "asset.wav.sampleRate",
        message: `Recipe sample rate is ${expected} Hz; the file is ${info.sampleRate} Hz. Metadata records the file.`,
      });
    }
    return {
      artifactBytes: context.sourceBytes,
      metadata,
      ...(diagnostics.length > 0 ? { diagnostics } : {}),
    };
  }
}
