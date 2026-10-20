import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { hashBytes, hashJson } from "../src/hash.js";

test("hashBytes matches node:crypto for empty, ascii and high bytes", () => {
  const samples = [
    new Uint8Array(),
    new TextEncoder().encode("kinetra"),
    Uint8Array.from([0, 1, 127, 128, 255]),
  ];
  for (const bytes of samples) {
    assert.equal(hashBytes(bytes), createHash("sha256").update(bytes).digest("hex"));
  }
});

test("hashJson matches hashing the canonical UTF-8 text", () => {
  const value = { b: 1, a: "é" };
  const canonical = JSON.stringify({ a: "é", b: 1 });
  assert.equal(hashJson(value), createHash("sha256").update(canonical, "utf8").digest("hex"));
});
