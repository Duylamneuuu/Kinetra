import { readFile } from "node:fs/promises";

import { hashBytes } from "./hash.js";

/** SHA-256 of a file on disk. Node-only; the browser entry hashes bytes the caller already has. */
export async function hashFile(path: string): Promise<string> {
  const buf = await readFile(path);
  return hashBytes(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
}
