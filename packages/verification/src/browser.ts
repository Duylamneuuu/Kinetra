/**
 * Browser-safe entry (`@kinetra/verification/browser`).
 *
 * Manifest types, the runtime probe, critique contracts, performance-budget math and the
 * PNG artifact-writer hook. A game module bundled into the renderer imports this.
 *
 * `AcceptanceRunner` and the PNG helpers stay on `@kinetra/verification`. They decode
 * screenshots with `pngjs`, which is CommonJS and pulls Node's `zlib`, `stream` and `util`.
 * A `platform: "browser"` bundle of those modules fails to resolve those builtins (#420).
 * Node acceptance runs keep importing the package root, which also registers the PNG writer
 * and the Electron host.
 */
export * from "./types.js";
export * from "./runtime-probe.js";
export * from "./critique.js";
export * from "./performance.js";
export { setPngArtifactWriter, type PngArtifactWriter } from "./artifact-writer.js";
