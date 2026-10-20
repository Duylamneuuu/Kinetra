import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { sha256Hex, sha256Utf8 } from "../src/sha256.js";

test("sha256 helpers match node:crypto", () => {
  const bytes = Uint8Array.from([0, 1, 127, 128, 255]);
  assert.equal(sha256Hex(bytes), createHash("sha256").update(bytes).digest("hex"));
  assert.equal(sha256Hex(new Uint8Array()), createHash("sha256").update(new Uint8Array()).digest("hex"));
  assert.equal(sha256Utf8("hips=Hips\nspine=Spine"), createHash("sha256").update("hips=Hips\nspine=Spine", "utf8").digest("hex"));
});
