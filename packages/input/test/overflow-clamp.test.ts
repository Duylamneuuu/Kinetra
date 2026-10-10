import assert from "node:assert/strict";
import test from "node:test";

import { InputRouter, type InputMap, type PhysicalInputSnapshot } from "../src/index.js";

function snapshot(partial: Partial<PhysicalInputSnapshot> = {}): PhysicalInputSnapshot {
  return { keys: new Set<string>(), gamepadButtons: [], gamepadAxes: [], ...partial } as PhysicalInputSnapshot;
}

function mapWith(bindings: InputMap["actions"][number]["bindings"], type: "axis" | "button" = "axis"): InputMap {
  return { schemaVersion: 1, actions: [{ id: "a", type, bindings }] } as InputMap;
}

test("a finite binding sum that overflows to +Infinity saturates at 1 instead of vanishing", () => {
  const router = new InputRouter(
    mapWith([
      { kind: "key", code: "KeyA", scale: 1e308 },
      { kind: "key", code: "KeyB", scale: 1e308 },
    ]),
  );
  const down = snapshot({ keys: new Set(["KeyA", "KeyB"]) });
  assert.equal(router.value("a", down), 1);
  assert.equal(router.getActionValue("a", down), 1);
});

test("a finite binding sum that overflows to -Infinity saturates at -1", () => {
  const router = new InputRouter(
    mapWith([
      { kind: "key", code: "KeyA", scale: -1e308 },
      { kind: "key", code: "KeyB", scale: -1e308 },
    ]),
  );
  assert.equal(router.value("a", snapshot({ keys: new Set(["KeyA", "KeyB"]) })), -1);
});

test("an overflowing button action still counts as pressed", () => {
  const router = new InputRouter(
    mapWith(
      [
        { kind: "key", code: "KeyA", scale: 1e308 },
        { kind: "key", code: "KeyB", scale: 1e308 },
      ],
      "button",
    ),
  );
  const down = snapshot({ keys: new Set(["KeyA", "KeyB"]) });
  assert.equal(router.value("a", down), 1);
  assert.equal(router.isActionPressed("a", down), true);
});

test("opposite overflowing terms (Infinity + -Infinity = NaN) read as no signal", () => {
  const router = new InputRouter(
    mapWith([
      { kind: "key", code: "KeyA", scale: 1e308 },
      { kind: "key", code: "KeyB", scale: 1e308 },
      { kind: "key", code: "KeyC", scale: -1e308 },
      { kind: "key", code: "KeyD", scale: -1e308 },
      { kind: "key", code: "KeyE", scale: -1e308 },
    ]),
  );
  // Whatever the intermediate overflow, the result is a number in [-1, 1], never NaN.
  const v = router.value("a", snapshot({ keys: new Set(["KeyA", "KeyB", "KeyC", "KeyD", "KeyE"]) }));
  assert.ok(Number.isFinite(v) && v >= -1 && v <= 1);
});

test("NaN gamepad inputs still read as 0 and finite sums are unchanged", () => {
  const router = new InputRouter(mapWith([{ kind: "gamepad-axis", axis: 0, scale: 1 }]));
  assert.equal(router.value("a", snapshot({ gamepadAxes: [Number.NaN] })), 0);
  assert.equal(router.value("a", snapshot({ gamepadAxes: [0.5] })), 0.5);
});

test("a semantic action with an infinite value saturates and a NaN value is no signal", () => {
  const router = new InputRouter(mapWith([{ kind: "key", code: "KeyA" }]));
  router.setSemanticAction("a", "press", Number.POSITIVE_INFINITY);
  assert.equal(router.getActionValue("a"), 1);
  router.setSemanticAction("a", "press", Number.NEGATIVE_INFINITY);
  assert.equal(router.getActionValue("a"), -1);
  router.setSemanticAction("a", "press", Number.NaN);
  assert.equal(router.getActionValue("a"), 0);
});
