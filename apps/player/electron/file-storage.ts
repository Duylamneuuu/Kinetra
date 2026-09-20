import {
  copyFile,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { resolve, sep } from "node:path";

const SAFE_KEY_PATTERN = /^[a-zA-Z0-9_-]+(\.[a-zA-Z0-9_-]+)*$/;

export class FileKeyValueStorage {
  readonly rootDir: string;

  constructor(rootDir: string) {
    if (!rootDir || typeof rootDir !== "string") {
      throw new TypeError("FileKeyValueStorage rootDir must be a non-empty string");
    }
    this.rootDir = resolve(rootDir);
  }

  resolveFilePath(key: string): string {
    if (typeof key !== "string" || !key) {
      throw new TypeError("Storage key must be a non-empty string");
    }

    // Strip prefix if formatted as "prefix:key" (e.g. "saves:slot-a" -> "slot-a")
    const cleanKey = key.startsWith("saves:") ? key.slice("saves:".length) : key;

    if (!SAFE_KEY_PATTERN.test(cleanKey)) {
      throw new Error(
        `Invalid storage key "${key}": contains illegal characters or path traversal sequences`,
      );
    }

    const filePath = resolve(this.rootDir, `${cleanKey}.json`);
    const normalizedRoot = resolve(this.rootDir);

    // Strict path boundary assertion
    if (!filePath.startsWith(normalizedRoot + sep) && filePath !== normalizedRoot) {
      throw new Error(
        `Invalid storage key "${key}": path traversal outside root directory`,
      );
    }

    return filePath;
  }

  async get(key: string): Promise<string | undefined> {
    const filePath = this.resolveFilePath(key);
    try {
      return await readFile(filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw err;
    }
  }

  async set(key: string, value: string): Promise<void> {
    if (typeof value !== "string") {
      throw new TypeError("Storage value must be a string");
    }

    const filePath = this.resolveFilePath(key);
    await mkdir(this.rootDir, { recursive: true });

    // Atomic write via sibling temporary file + rename replacement
    const tempPath = `${filePath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;

    await writeFile(tempPath, value, "utf8");

    try {
      await rename(tempPath, filePath);
    } catch {
      // On Windows NTFS, transient locks by antivirus or file monitors can cause rename to fail.
      // Retry with short backoff, then fall back to copyFile + unlink.
      let replaced = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        await new Promise((resolveWait) => setTimeout(resolveWait, attempt * 10));
        try {
          await rename(tempPath, filePath);
          replaced = true;
          break;
        } catch {
          // Continue to next attempt
        }
      }

      if (!replaced) {
        await copyFile(tempPath, filePath);
        await unlink(tempPath).catch(() => {});
      }
    }
  }

  async delete(key: string): Promise<void> {
    const filePath = this.resolveFilePath(key);
    try {
      await unlink(filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw err;
    }
  }
}
