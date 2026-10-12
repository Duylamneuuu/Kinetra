import assert from "node:assert/strict";
import test from "node:test";

import { decodeBase64, encodeBase64, isBase64 } from "../src/base64.js";

const sample = (length: number): Uint8Array => {
  const bytes = new Uint8Array(length);
  let state = 0x9e3779b9 ^ length;
  for (let index = 0; index < length; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    bytes[index] = state >>> 24;
  }
  return bytes;
};

test("encodeBase64 / decodeBase64 equal Node's Buffer at every length from 0 to 300", () => {
  for (let length = 0; length <= 300; length += 1) {
    const bytes = sample(length);
    const expected = Buffer.from(bytes).toString("base64");
    assert.equal(encodeBase64(bytes), expected, `encode length ${length}`);
    assert.deepEqual(decodeBase64(expected), bytes, `decode length ${length}`);
  }
});

test("all 256 byte values and the RFC 4648 vectors round trip", () => {
  const all = Uint8Array.from({ length: 256 }, (_, index) => index);
  assert.deepEqual(decodeBase64(encodeBase64(all)), all);
  const text = (value: string): Uint8Array => new TextEncoder().encode(value);
  const vectors: Array<[string, string]> = [
    ["", ""],
    ["f", "Zg=="],
    ["fo", "Zm8="],
    ["foo", "Zm9v"],
    ["foob", "Zm9vYg=="],
    ["fooba", "Zm9vYmE="],
    ["foobar", "Zm9vYmFy"],
  ];
  for (const [plain, encoded] of vectors) {
    assert.equal(encodeBase64(text(plain)), encoded);
    assert.deepEqual(decodeBase64(encoded), text(plain));
  }
});

test("decodeBase64 refuses malformed input instead of skipping characters", () => {
  for (const bad of ["Zg=", "Zg", "Z===", "Zm9v!", "Zm 9v", "Zm9v\n", "=Zm9", "Zg==Zg==", "Zm9vYg=a", "é===", "-_-_"]) {
    assert.equal(isBase64(bad), false, JSON.stringify(bad));
    assert.throws(() => decodeBase64(bad), TypeError, JSON.stringify(bad));
  }
  assert.equal(isBase64(42), false);
  assert.equal(isBase64(undefined), false);
  assert.equal(isBase64(""), true);
});
