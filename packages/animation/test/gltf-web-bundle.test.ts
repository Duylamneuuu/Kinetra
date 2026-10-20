import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * `tsc` emits `gltf-web.js` as a re-export of `@gltf-transform/core`. The package build then
 * replaces that file with a bundle that drops `NodeIO`. A renderer build fails if the re-export
 * is what ships, because `NodeIO` dynamically imports `node:fs` from the same module (#420).
 */
test("gltf-web.js is the inlined bundle, not a re-export of @gltf-transform/core (Refs #420)", async () => {
  const source = await readFile(new URL("../src/gltf-web.js", import.meta.url), "utf8");
  assert.equal(source.includes('from "@gltf-transform/core"'), false);
  assert.equal(source.includes("from '@gltf-transform/core'"), false);
  assert.equal(source.includes("node:fs"), false);
  assert.equal(source.includes("node:path"), false);
  assert.match(source, /export \{[^}]*\bWebIO\b/);
});
