import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { sha256Hex } from "../src/sha256.js";

test("sha256Hex matches node:crypto for screenshot-sized buffers", () => {
  const bytes = new Uint8Array(300);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = i & 0xff;
  assert.equal(sha256Hex(bytes), createHash("sha256").update(bytes).digest("hex"));
  assert.equal(sha256Hex(new Uint8Array()), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});
