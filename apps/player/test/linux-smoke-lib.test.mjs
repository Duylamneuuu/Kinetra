import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import test from "node:test";

import {
  assertLinuxHostInfo,
  assertSemanticMove,
  descendantPids,
  inspectPng,
  pidsUsingPath,
} from "../scripts/linux-smoke-lib.mjs";

test("inspectPng accepts a varied PNG and rejects a non-PNG", () => {
  const png = encodePng(64, 48, (x, y) => [x * 3, y * 5, (x + y) * 2]);
  const inspected = inspectPng(png, {
    minBytes: 32,
    minUniqueBytes: 16,
    minWidth: 32,
    minHeight: 32,
  });
  assert.equal(inspected.width, 64);
  assert.equal(inspected.height, 48);
  assert.ok(inspected.uniqueBytes >= 16);
  assert.ok(inspected.byteLength > 32);

  assert.throws(
    () => inspectPng(Buffer.from("not a png"), { minBytes: 1 }),
    /not a PNG/,
  );
});

test("inspectPng rejects frames that are too small or lack pixel variety", () => {
  const tiny = encodePng(2, 2, () => [10, 20, 30]);
  assert.throws(
    () =>
      inspectPng(tiny, {
        minBytes: 10_000,
        minUniqueBytes: 1,
        minWidth: 1,
        minHeight: 1,
      }),
    /too small/,
  );

  const flat = encodePng(8, 8, () => [1, 2, 3]);
  assert.throws(
    () =>
      inspectPng(flat, {
        minBytes: 1,
        minUniqueBytes: 250,
        minWidth: 1,
        minHeight: 1,
      }),
    /pixel variety/,
  );
});

test("assertSemanticMove requires forward movement and arena controller state", () => {
  const before = queryAt(-5, 0, undefined);
  const after = queryAt(-6, 1, "player.moveForward");
  assert.deepEqual(assertSemanticMove(before, after), {
    beforeZ: -5,
    afterZ: -6,
    moveCount: 1,
    lastAction: "player.moveForward",
  });

  assert.throws(
    () => assertSemanticMove(before, queryAt(-5, 1, "player.moveForward")),
    /did not move the player forward/,
  );
  assert.throws(
    () => assertSemanticMove(before, queryAt(-6, 0, "player.moveForward")),
    /moveCount/,
  );
  assert.throws(
    () => assertSemanticMove(before, queryAt(-6, 1, "player.moveRight")),
    /lastAction/,
  );
});

test("assertLinuxHostInfo accepts only an unpackaged Linux Electron host", () => {
  assert.equal(
    assertLinuxHostInfo({
      platform: "linux",
      arch: "x64",
      isPackaged: false,
      execPath: "/opt/electron",
    }).platform,
    "linux",
  );
  assert.throws(
    () =>
      assertLinuxHostInfo({
        platform: "win32",
        arch: "x64",
        isPackaged: false,
        execPath: "/opt/electron",
      }),
    /expected linux/,
  );
  assert.throws(
    () =>
      assertLinuxHostInfo({
        platform: "linux",
        arch: "x64",
        isPackaged: true,
        execPath: "/opt/electron",
      }),
    /isPackaged false/,
  );
});

test("process helpers find descendants and user-data matches", () => {
  const processes = [
    { pid: 10, ppid: 1, cmdline: "electron", environ: "" },
    { pid: 11, ppid: 10, cmdline: "electron --type=zygote", environ: "" },
    { pid: 12, ppid: 11, cmdline: "electron --type=gpu", environ: "KINETRA_USER_DATA_DIR=/tmp/kinetra-a" },
    { pid: 20, ppid: 1, cmdline: "unrelated", environ: "" },
  ];
  assert.deepEqual(descendantPids(processes, 10).sort((a, b) => a - b), [11, 12]);
  assert.deepEqual(pidsUsingPath(processes, "/tmp/kinetra-a"), [12]);
  assert.deepEqual(pidsUsingPath(processes, "/tmp/kinetra-missing"), []);
});

/**
 * @param {number} z
 * @param {number} moveCount
 * @param {string | undefined} lastAction
 */
function queryAt(z, moveCount, lastAction) {
  return {
    entities: [
      {
        name: "Player",
        position: [-5, 0.5, z],
        gameplay: {
          state: {
            moveCount,
            ...(lastAction !== undefined ? { lastAction } : {}),
          },
        },
      },
    ],
  };
}

/**
 * @param {number} width
 * @param {number} height
 * @param {(x: number, y: number) => [number, number, number]} pixel
 */
function encodePng(width, height, pixel) {
  const raw = Buffer.alloc((1 + width * 3) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 3);
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const [red, green, blue] = pixel(x, y);
      const offset = row + 1 + x * 3;
      raw[offset] = red & 255;
      raw[offset + 1] = green & 255;
      raw[offset + 2] = blue & 255;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * @param {string} type
 * @param {Buffer} data
 */
function chunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])) >>> 0, 0);
  return Buffer.concat([length, typeBytes, data, crc]);
}

/**
 * @param {Buffer} buffer
 */
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const value of buffer) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return crc ^ 0xffffffff;
}
