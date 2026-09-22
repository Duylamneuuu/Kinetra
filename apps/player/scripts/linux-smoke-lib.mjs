import { inflateSync } from "node:zlib";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * @param {Buffer | Uint8Array} bytes
 * @param {{
 *   minBytes?: number;
 *   minUniqueBytes?: number;
 *   minWidth?: number;
 *   minHeight?: number;
 * }} [options]
 */
export function inspectPng(bytes, options = {}) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const minBytes = options.minBytes ?? 8_000;
  const minUniqueBytes = options.minUniqueBytes ?? 16;
  const minWidth = options.minWidth ?? 640;
  const minHeight = options.minHeight ?? 360;

  if (buffer.length < minBytes) {
    throw new Error(
      `PNG is too small to be a real player frame (${buffer.length} bytes; need at least ${minBytes})`,
    );
  }

  for (let index = 0; index < PNG_SIGNATURE.length; index += 1) {
    if (buffer[index] !== PNG_SIGNATURE[index]) {
      throw new Error("Frame is not a PNG (missing signature)");
    }
  }

  const chunks = readPngChunks(buffer);
  const ihdr = chunks.find((chunk) => chunk.type === "IHDR");
  if (!ihdr || ihdr.data.length < 8) {
    throw new Error("PNG is missing an IHDR chunk");
  }

  const width = ihdr.data.readUInt32BE(0);
  const height = ihdr.data.readUInt32BE(4);
  if (width < minWidth || height < minHeight) {
    throw new Error(
      `PNG dimensions ${width}x${height} are smaller than ${minWidth}x${minHeight}`,
    );
  }

  const idat = Buffer.concat(
    chunks.filter((chunk) => chunk.type === "IDAT").map((chunk) => chunk.data),
  );
  if (idat.length === 0) {
    throw new Error("PNG is missing IDAT image data");
  }

  const inflated = inflateSync(idat);
  const uniqueBytes = countUniqueBytes(inflated);
  if (uniqueBytes < minUniqueBytes) {
    throw new Error(
      `PNG frame lacks pixel variety (${uniqueBytes} unique inflated bytes; need at least ${minUniqueBytes})`,
    );
  }

  return {
    width,
    height,
    byteLength: buffer.length,
    uniqueBytes,
  };
}

/**
 * @param {Buffer} buffer
 */
function readPngChunks(buffer) {
  /** @type {{ type: string; data: Buffer }[]} */
  const chunks = [];
  let offset = PNG_SIGNATURE.length;

  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buffer.length) {
      throw new Error(`PNG chunk ${type} is truncated`);
    }
    chunks.push({ type, data: buffer.subarray(dataStart, dataEnd) });
    offset = dataEnd + 4;
    if (type === "IEND") {
      break;
    }
  }

  if (!chunks.some((chunk) => chunk.type === "IEND")) {
    throw new Error("PNG is missing an IEND chunk");
  }

  return chunks;
}

/**
 * @param {Buffer} buffer
 */
function countUniqueBytes(buffer) {
  const seen = new Uint8Array(256);
  let count = 0;
  for (const value of buffer) {
    if (seen[value] === 0) {
      seen[value] = 1;
      count += 1;
    }
  }
  return count;
}

/**
 * @param {unknown} query
 * @param {string} name
 */
export function findEntity(query, name) {
  if (!isRecord(query) || !Array.isArray(query.entities)) {
    throw new Error("Runtime query is missing an entities array");
  }

  const entity = query.entities.find(
    (candidate) => isRecord(candidate) && candidate.name === name,
  );
  if (!entity || !isRecord(entity)) {
    throw new Error(`Runtime query has no entity named ${name}`);
  }
  return entity;
}

/**
 * Prove semantic `player.moveForward` changed Kinetra Arena state.
 * @param {unknown} beforeQuery
 * @param {unknown} afterQuery
 */
export function assertSemanticMove(beforeQuery, afterQuery) {
  const before = findEntity(beforeQuery, "Player");
  const after = findEntity(afterQuery, "Player");
  const beforeZ = positionAxis(before, 2, "before");
  const afterZ = positionAxis(after, 2, "after");
  const state = isRecord(after.gameplay) ? after.gameplay.state : undefined;
  const moveCount = isRecord(state) ? state.moveCount : undefined;
  const lastAction = isRecord(state) ? state.lastAction : undefined;

  if (!(afterZ <= beforeZ - 0.5)) {
    throw new Error(
      `player.moveForward did not move the player forward (z ${beforeZ} -> ${afterZ})`,
    );
  }
  if (typeof moveCount !== "number" || moveCount < 1) {
    throw new Error(
      `player.moveForward did not increment ArenaPlayerController.moveCount (got ${String(moveCount)})`,
    );
  }
  if (lastAction !== "player.moveForward") {
    throw new Error(
      `ArenaPlayerController.lastAction is ${String(lastAction)}, expected player.moveForward`,
    );
  }

  return { beforeZ, afterZ, moveCount, lastAction };
}

/**
 * @param {unknown} info
 */
export function assertLinuxHostInfo(info) {
  if (!isRecord(info)) {
    throw new Error("runtime.hostInfo did not return an object");
  }
  if (info.platform !== "linux") {
    throw new Error(
      `runtime.hostInfo.platform is ${String(info.platform)}, expected linux`,
    );
  }
  if (typeof info.arch !== "string" || info.arch.length === 0) {
    throw new Error("runtime.hostInfo.arch must be a non-empty string");
  }
  if (info.isPackaged !== false) {
    throw new Error(
      "Linux dev-Electron smoke must report isPackaged false. Packaged proof is Windows KinetraGame.exe.",
    );
  }
  if (typeof info.execPath !== "string" || !/electron/i.test(info.execPath)) {
    throw new Error(
      `runtime.hostInfo.execPath does not identify Electron (${String(info.execPath)})`,
    );
  }
  return {
    platform: info.platform,
    arch: info.arch,
    isPackaged: false,
    execPath: info.execPath,
  };
}

/**
 * @param {{ pid: number; ppid: number }[]} processes
 * @param {number} rootPid
 */
export function descendantPids(processes, rootPid) {
  /** @type {Map<number, number[]>} */
  const children = new Map();
  for (const proc of processes) {
    const list = children.get(proc.ppid) ?? [];
    list.push(proc.pid);
    children.set(proc.ppid, list);
  }

  /** @type {number[]} */
  const result = [];
  const seen = new Set();
  const stack = [...(children.get(rootPid) ?? [])];
  while (stack.length > 0) {
    const pid = stack.pop();
    if (pid === undefined || seen.has(pid)) {
      continue;
    }
    seen.add(pid);
    result.push(pid);
    for (const child of children.get(pid) ?? []) {
      stack.push(child);
    }
  }
  return result;
}

/**
 * @param {{ pid: number; cmdline: string; environ?: string }[]} processes
 * @param {string} userDataDir
 */
export function pidsUsingPath(processes, userDataDir) {
  return processes
    .filter((proc) =>
      `${proc.cmdline}\n${proc.environ ?? ""}`.includes(userDataDir),
    )
    .map((proc) => proc.pid);
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {Record<string, unknown>} entity
 * @param {number} axis
 * @param {string} label
 */
function positionAxis(entity, axis, label) {
  const position = entity.position;
  if (!Array.isArray(position) || typeof position[axis] !== "number") {
    throw new Error(`Player position is missing on the ${label} query`);
  }
  return position[axis];
}
