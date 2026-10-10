import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_PLAYER_INPUT_MAP,
  InputRouter,
  describeInvalidInputMap,
  type InputMap,
} from "../src/index.js";

const valid = (): InputMap => ({
  schemaVersion: 1,
  actions: [{ id: "a", type: "axis", bindings: [{ kind: "key", code: "KeyD" }] }],
});

test("the default map and an empty action list are valid", () => {
  assert.equal(describeInvalidInputMap(DEFAULT_PLAYER_INPUT_MAP), undefined);
  assert.equal(describeInvalidInputMap({ schemaVersion: 1, actions: [] }), undefined);
  assert.doesNotThrow(() => new InputRouter(valid()));
});

test("InputRouter constructor rejects malformed maps with a clear error instead of failing later", () => {
  const bad: Array<[string, unknown, RegExp]> = [
    ["null", null, /must be an object/],
    ["array", [], /must be an object/],
    ["missing actions", { schemaVersion: 1 }, /actions must be an array/],
    ["actions object", { schemaVersion: 1, actions: {} }, /actions must be an array/],
    ["wrong schemaVersion", { schemaVersion: 2, actions: [] }, /schemaVersion/],
    ["null action", { schemaVersion: 1, actions: [null] }, /actions\[0\] must be an object/],
    ["empty id", { schemaVersion: 1, actions: [{ id: "", type: "axis", bindings: [] }] }, /non-empty string id/],
    ["bad type", { schemaVersion: 1, actions: [{ id: "a", type: "stick", bindings: [] }] }, /type must be/],
    ["missing bindings", { schemaVersion: 1, actions: [{ id: "a", type: "axis" }] }, /bindings must be an array/],
    ["null binding", { schemaVersion: 1, actions: [{ id: "a", type: "axis", bindings: [null] }] }, /binding 0/],
    [
      "bad deadzone",
      { schemaVersion: 1, actions: [{ id: "a", type: "axis", bindings: [{ kind: "gamepad-axis", axis: 0, deadzone: 5 }] }] },
      /deadzone/,
    ],
    [
      "duplicate ids",
      {
        schemaVersion: 1,
        actions: [
          { id: "a", type: "axis", bindings: [] },
          { id: "a", type: "button", bindings: [] },
        ],
      },
      /duplicate action id "a"/,
    ],
  ];
  for (const [label, map, pattern] of bad) {
    assert.match(describeInvalidInputMap(map) ?? "", pattern, label);
    assert.throws(() => new InputRouter(map as InputMap), (error: unknown) => {
      assert.ok(error instanceof Error, label);
      assert.match(error.message, /^Invalid input map: /, label);
      assert.match(error.message, pattern, label);
      return true;
    });
  }
});

test("exportMap output always round-trips through the constructor", () => {
  const router = new InputRouter();
  router.remap("player.jump", [{ kind: "key", code: "KeyZ", scale: 2 }]);
  const exported = router.exportMap();
  assert.equal(describeInvalidInputMap(exported), undefined);
  assert.deepEqual(new InputRouter(exported).exportMap(), exported);
});
