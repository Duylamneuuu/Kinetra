import {
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { KeyValueStorage } from "./index.js";

const SAFE_KEY_PATTERN = /^[a-zA-Z0-9_-]+(\.[a-zA-Z0-9_-]+)*$/;

export interface FileStorageOptions {
  /** Optional custom replacement primitive, primarily for deterministic testing */
  renameFile?: (sourcePath: string, targetPath: string) => Promise<void>;
  /** Max retry attempts on rename failure before giving up (default 3) */
  renameRetryAttempts?: number;
  /** Backoff delay per retry attempt in ms (default 10) */
  retryDelayMs?: number;
}

export class FileKeyValueStorage implements KeyValueStorage {
  readonly rootDir: string;
  readonly #renameFile: (sourcePath: string, targetPath: string) => Promise<void>;
  readonly #retryAttempts: number;
  readonly #retryDelayMs: number;

  constructor(rootDir: string, options: FileStorageOptions = {}) {
    if (!rootDir || typeof rootDir !== "string") {
      throw new TypeError("FileKeyValueStorage rootDir must be a non-empty string");
    }
    this.rootDir = resolve(rootDir);
    this.#renameFile = options.renameFile ?? rename;
    this.#retryAttempts = options.renameRetryAttempts ?? 3;
    this.#retryDelayMs = options.retryDelayMs ?? 10;
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

    // Crash-resistant atomic replacement of completed temp files
    const tempPath = `${filePath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;

    // 1. Open temp handle, write full contents, sync/flush, and close
    const handle = await open(tempPath, "w");
    try {
      await handle.writeFile(value, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }

    // 2. Attempt atomic rename/replace with bounded retry on Windows NTFS
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.#retryAttempts; attempt++) {
      if (attempt > 0) {
        await new Promise((resolveWait) =>
          setTimeout(resolveWait, attempt * this.#retryDelayMs),
        );
      }
      try {
        await this.#renameFile(tempPath, filePath);
        return;
      } catch (err) {
        lastError = err;
      }
    }

    // 3. If atomic replacement fails after bounded retry, clean up temp file safely and throw.
    // The existing final save document remains completely untouched (never partially overwritten).
    await unlink(tempPath).catch(() => {});
    throw (
      lastError instanceof Error
        ? lastError
        : new Error(`Failed to atomically replace save file "${filePath}"`)
    );
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
