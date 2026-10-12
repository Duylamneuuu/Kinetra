/**
 * Portable base64 (RFC 4648, standard alphabet, padded). Orb Run's entry must load in a renderer
 * bundle where `Buffer` does not exist, so nothing reachable from `src/index.ts` may use it.
 */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const VALID = /^[A-Za-z0-9+/]*={0,2}$/;

const DECODE = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let index = 0; index < ALPHABET.length; index += 1) table[ALPHABET.charCodeAt(index)] = index;
  return table;
})();

export function encodeBase64(bytes: Uint8Array): string {
  let out = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index] as number;
    const b = index + 1 < bytes.length ? (bytes[index + 1] as number) : 0;
    const c = index + 2 < bytes.length ? (bytes[index + 2] as number) : 0;
    const word = (a << 16) | (b << 8) | c;
    out += ALPHABET[(word >> 18) & 63] as string;
    out += ALPHABET[(word >> 12) & 63] as string;
    out += index + 1 < bytes.length ? (ALPHABET[(word >> 6) & 63] as string) : "=";
    out += index + 2 < bytes.length ? (ALPHABET[word & 63] as string) : "=";
  }
  return out;
}

/** True for padded standard base64 whose length is a multiple of four. */
export function isBase64(text: unknown): text is string {
  // The pattern only lets `=` close the string (at most two), so padding can't appear mid-way.
  return typeof text === "string" && text.length % 4 === 0 && VALID.test(text);
}

/** Decodes padded standard base64; throws a `TypeError` for anything else (never skips characters). */
export function decodeBase64(text: string): Uint8Array {
  if (!isBase64(text)) throw new TypeError("not valid base64");
  const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  const out = new Uint8Array((text.length / 4) * 3 - padding);
  let written = 0;
  for (let index = 0; index < text.length; index += 4) {
    let word = 0;
    for (let offset = 0; offset < 4; offset += 1) {
      const char = text.charCodeAt(index + offset);
      word = (word << 6) | (char === 61 ? 0 : (DECODE[char] as number));
    }
    if (written < out.length) out[written++] = (word >> 16) & 255;
    if (written < out.length) out[written++] = (word >> 8) & 255;
    if (written < out.length) out[written++] = word & 255;
  }
  return out;
}
