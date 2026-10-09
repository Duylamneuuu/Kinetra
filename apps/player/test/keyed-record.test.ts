import assert from "node:assert/strict";
import test from "node:test";

import { compareCodeUnits, createKeyedRecord } from "../src/keyed-record.js";

test("createKeyedRecord keeps __proto__ and constructor as own keys", () => {
  const record = createKeyedRecord<number>([
    ["__proto__", 1],
    ["constructor", 2],
    ["toString", 3],
    ["plain", 4],
  ]);

  assert.deepEqual(Object.keys(record).sort(), ["__proto__", "constructor", "plain", "toString"]);
  assert.equal(Object.getPrototypeOf(record), null);
  assert.equal(Object.getOwnPropertyDescriptor(record, "__proto__")?.value, 1);
  assert.equal(record["constructor"], 2);
});

test("a plain object literal loses __proto__ (the bug createKeyedRecord avoids)", () => {
  const plain: Record<string, number> = {};
  plain["__proto__"] = 1;
  assert.deepEqual(Object.keys(plain), []);
});

test("records survive a JSON and structuredClone round trip with __proto__ intact", () => {
  const record = createKeyedRecord<{ n: number }>([
    ["__proto__", { n: 1 }],
    ["b", { n: 2 }],
  ]);

  const viaJson = JSON.parse(JSON.stringify(record)) as Record<string, { n: number }>;
  assert.deepEqual(Object.keys(viaJson).sort(), ["__proto__", "b"]);
  assert.equal(Object.getOwnPropertyDescriptor(viaJson, "__proto__")?.value.n, 1);

  const cloned = structuredClone(record);
  assert.deepEqual(Object.keys(cloned).sort(), ["__proto__", "b"]);
  assert.equal(Object.getOwnPropertyDescriptor(cloned, "__proto__")?.value.n, 1);
});

test("createKeyedRecord on later duplicate keys keeps the last value", () => {
  const record = createKeyedRecord<number>([
    ["a", 1],
    ["a", 2],
  ]);
  assert.deepEqual(Object.keys(record), ["a"]);
  assert.equal(record["a"], 2);
});

test("createKeyedRecord of nothing is an empty record", () => {
  assert.deepEqual(Object.keys(createKeyedRecord<number>([])), []);
});

test("compareCodeUnits orders by code unit, independent of locale", () => {
  // localeCompare puts "a" before "B"; code-unit order puts uppercase first.
  assert.ok(compareCodeUnits("B", "a") < 0);
  assert.ok(compareCodeUnits("a", "B") > 0);
  assert.equal(compareCodeUnits("same", "same"), 0);
  assert.ok(compareCodeUnits("a", "ab") < 0);
  assert.ok(compareCodeUnits("Z", "_") < 0);
  assert.ok(compareCodeUnits("e", "é") < 0);

  const ids = ["wall_10", "Wall_2", "wall_2", "__proto__", "player", "Player"];
  assert.deepEqual([...ids].sort(compareCodeUnits), ["Player", "Wall_2", "__proto__", "player", "wall_10", "wall_2"]);
});

test("compareCodeUnits is a consistent total order over a seeded fuzz of ids", () => {
  let seed = 0x2f6e2b1;
  const next = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  const alphabet = "aAbBzZ_09é-";
  const ids: string[] = [];
  for (let i = 0; i < 200; i += 1) {
    const length = 1 + (next() % 6);
    let id = "";
    for (let j = 0; j < length; j += 1) id += alphabet[next() % alphabet.length];
    ids.push(id);
  }
  const sorted = [...ids].sort(compareCodeUnits);
  for (let i = 1; i < sorted.length; i += 1) {
    assert.ok(compareCodeUnits(sorted[i - 1]!, sorted[i]!) <= 0);
    assert.ok(compareCodeUnits(sorted[i]!, sorted[i - 1]!) >= 0);
  }
  assert.deepEqual([...ids].reverse().sort(compareCodeUnits), sorted);
});
