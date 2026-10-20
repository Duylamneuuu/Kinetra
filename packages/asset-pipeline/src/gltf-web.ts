/**
 * In-memory glTF I/O (`Document`, `WebIO`, `getBounds`, `Logger`).
 *
 * This source re-exports `@gltf-transform/core`. `scripts/bundle-gltf-web.mjs` then
 * replaces `dist/src/gltf-web.js` with a bundle that drops `NodeIO`. That class
 * dynamically imports `node:fs` and `node:path` from the same file as `WebIO`, and a
 * browser bundler tries to resolve the import even though nothing calls `NodeIO` (#420).
 */
export { Document, Logger, WebIO, getBounds } from "@gltf-transform/core";
