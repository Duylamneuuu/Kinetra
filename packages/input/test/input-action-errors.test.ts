import assert from "node:assert/strict";
import test from "node:test";
import {
  InputRouter,
  describeUnknownInputAction,
  type InputMap,
} from "../src/index.js";

const emptySnapshot = {
  keys: new Set<string>(),
  gamepadButtons: [] as number[],
  gamepadAxes: [] as number[],
};

test("unknown input action names the registered ids", () => {
  const map: InputMap = {
    schemaVersion: 1,
    actions: [
      { id: "zeta", type: "button", bindings: [] },
      { id: "alpha", type: "axis", bindings: [] },
    ],
  };
  const router = new InputRouter(map);
  assert.deepEqual(router.listActionIds(), ["alpha", "zeta"]);
  router.listActionIds().push("mutated");
  assert.deepEqual(router.listActionIds(), ["alpha", "zeta"]);

  assert.throws(
    () => router.remap("missing", []),
    /Unknown input action "missing"[\s\S]*Available actions: alpha, zeta/,
  );
  assert.throws(
    () => router.value("missing", emptySnapshot),
    /Available actions: alpha, zeta/,
  );

  const empty = new InputRouter({ schemaVersion: 1, actions: [] });
  assert.throws(
    () => empty.remap("missing", []),
    /No input actions are registered/,
  );
});

test("default input map errors include player.attack before player.jump", () => {
  const router = new InputRouter();
  assert.throws(
    () => router.value("missing", emptySnapshot),
    /Available actions: [\s\S]*player\.attack, player\.jump/,
  );
});

test("describeUnknownInputAction caps the action list", () => {
  const ids = Array.from({ length: 14 }, (_, index) => `action-${String(index).padStart(2, "0")}`);
  const described = describeUnknownInputAction("missing", [...ids].reverse());
  assert.match(described, /Available actions: action-00, action-01/);
  assert.match(described, /and 2 more/);
  assert.equal(described.includes("action-12"), false);
});
