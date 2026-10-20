import { watch } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";

import { setDefaultFileSystem } from "./platform.js";
import type { FileSystemAdapter } from "./reimport.js";
import { setDefaultSourceWatchAdapter } from "./watcher.js";

/**
 * Disk defaults for the Node package entry. Imported for its side effect by `index.ts` only,
 * so `@kinetra/asset-pipeline/pure` does not pull `node:fs` into a renderer bundle.
 */
const nodeFileSystem: FileSystemAdapter = {
  async readFile(p: string) {
    const buf = await readFile(p);
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  },
  async writeFile(p: string, data: Uint8Array) {
    await writeFile(p, data);
  },
  async rename(oldPath: string, newPath: string) {
    // Windows rename resilience: if destination exists or is locked briefly, retry
    let retries = 3;
    while (retries > 0) {
      try {
        await rename(oldPath, newPath);
        return;
      } catch (err: unknown) {
        retries--;
        const code =
          typeof err === "object" && err !== null && "code" in err
            ? (err as { code?: unknown }).code
            : undefined;
        if (retries === 0 || (code !== "EPERM" && code !== "EBUSY")) {
          throw err;
        }
        await new Promise((r) => setTimeout(r, 20));
      }
    }
  },
  async unlink(p: string) {
    await unlink(p).catch(() => {});
  },
  async mkdir(p: string, options?: { recursive?: boolean }) {
    return await mkdir(p, options);
  },
};

setDefaultFileSystem(nodeFileSystem);

setDefaultSourceWatchAdapter({
  watch(path, listener) {
    return watch(path, (eventType) => listener(eventType));
  },
  async readFile(path) {
    const buf = await readFile(path);
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  },
});
