import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

import { sha256Hex } from "../src/sha256.js";

const node = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

test("sha256Hex matches the FIPS 180-4 reference vectors", () => {
  assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(
    sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
  );
});

test("sha256Hex equals node:crypto at every padding boundary and for non-ASCII text", () => {
  // 55/56/63/64/65 bytes straddle the one-block / two-block padding boundary; 119..129 the next one.
  for (let length = 0; length <= 200; length += 1) {
    const text = "x".repeat(length);
    assert.equal(sha256Hex(text), node(text), `length ${length}`);
  }
  for (const text of ["héllo", "日本語のテキスト", "emoji 🎮🧪", "\u0000\u0001", "lone surrogate \ud800 end", "a\nb\r\nc\t"]) {
    assert.equal(sha256Hex(text), node(text), JSON.stringify(text));
  }
});

test("sha256Hex handles a multi-megabyte input and stays deterministic", () => {
  const big = JSON.stringify(Array.from({ length: 60_000 }, (_, index) => ({ index, name: `event-${index}`, value: index / 7 })));
  assert.ok(big.length > 2_000_000);
  const first = sha256Hex(big);
  assert.equal(first, node(big));
  assert.equal(sha256Hex(big), first);
});

test("the package entry never imports node:* (it is bundled for the web player); only write-snapshot.ts and acceptance-suite.ts (the Node-only CLI side) may", async () => {
  const dir = new URL("../src/", import.meta.url);
  const files = (await readdir(dir)).filter(
    (name) => name.endsWith(".js") && name !== "write-snapshot.js" && name !== "acceptance-suite.js",
  );
  assert.ok(files.includes("replay.js") && files.includes("sha256.js") && files.includes("index.js"));
  for (const file of files) {
    const source = await readFile(new URL(file, dir), "utf8");
    assert.doesNotMatch(source, /(?:from|import)\s*\(?\s*["']node:/, `${file} imports a node:* module`);
    assert.doesNotMatch(source, /require\(\s*["']node:/, `${file} requires a node:* module`);
  }
  const index = await readFile(new URL("index.js", dir), "utf8");
  assert.doesNotMatch(index, /write-snapshot/, "index must not re-export write-snapshot");
  assert.doesNotMatch(index, /acceptance-suite/, "index must not re-export the Node-only acceptance suite");
});

test("digestOrbRunState is cached per state revision and refreshed by steps and restores", async () => {
  const { startOrbRunSimulation, digestOrbRunState } = await import("../src/index.js");
  const simulation = await startOrbRunSimulation();
  try {
    const before = digestOrbRunState(simulation);
    const revision = simulation.stateRevision;
    // Repeated reads of an unchanged state are the same string and do not move the revision.
    assert.equal(digestOrbRunState(simulation), before);
    assert.equal(simulation.stateRevision, revision);
    simulation.advance(1);
    assert.ok(simulation.stateRevision > revision);
    const afterStep = digestOrbRunState(simulation);
    assert.notEqual(afterStep, before);
    // restorePosition changes the state at the same step: the cache must not serve the stale digest.
    const [entityId] = Object.keys(simulation.positions());
    const position = simulation.getPosition(entityId!)!;
    simulation.restorePosition(entityId!, [position[0] + 5, position[1], position[2]]);
    const afterRestore = digestOrbRunState(simulation);
    assert.notEqual(afterRestore, afterStep);
    simulation.restorePosition(entityId!, position);
    assert.equal(digestOrbRunState(simulation), afterStep);
  } finally {
    await simulation.dispose();
  }
});
