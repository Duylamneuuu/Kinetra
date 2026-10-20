import type { FileSystemAdapter } from "./reimport.js";

/**
 * Disk access used when a caller omits `fileSystem`. The Node package entry registers an
 * implementation (`node-platform.ts`). The browser entry (`pure.ts`) does not, so a renderer
 * bundle never imports `node:fs`; callers there pass their own adapter.
 */
let installed: FileSystemAdapter | undefined;

export function setDefaultFileSystem(fileSystem: FileSystemAdapter): void {
  installed = fileSystem;
}

export function requireDefaultFileSystem(): FileSystemAdapter {
  if (!installed) {
    throw new Error(
      "[asset-pipeline.platform.missingFileSystem] Pass options.fileSystem, or import @kinetra/asset-pipeline so the Node entry can register a disk file system.",
    );
  }
  return installed;
}
