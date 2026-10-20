/**
 * In-memory glTF read (`WebIO`) for skeleton inspection.
 *
 * This source re-exports `@gltf-transform/core`. `scripts/bundle-gltf-web.mjs` then
 * replaces `dist/src/gltf-web.js` with a bundle that drops `NodeIO`, whose dynamic
 * `node:fs` / `node:path` import would otherwise fail a renderer build (#420).
 */
export { WebIO } from "@gltf-transform/core";
