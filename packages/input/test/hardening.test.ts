import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_PLAYER_INPUT_MAP,
  InputRouter,
  describeInvalidInputBinding,
  type InputBinding,
  type InputMap,
  type PhysicalInputSnapshot,
} from "../src/index.js";

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const map: InputMap = {
  schemaVersion: 1,
  actions: [
    {
      id: "move",
      type: "axis",
      bindings: [
        { kind: "key", code: "KeyD", scale: 1 },
        { kind: "key", code: "KeyA", scale: -1 },
        { kind: "gamepad-axis", axis: 0, deadzone: 0.2 },
        { kind: "gamepad-axis", axis: 1, direction: "positive", scale: 0.5 },
        { kind: "gamepad-axis", axis: 2, direction: "negative" },
      ],
    },
    {
      id: "jump",
      type: "button",
      bindings: [
        { kind: "key", code: "Space" },
        { kind: "gamepad-button", button: 0 },
      ],
    },
  ],
};

function snapshot(partial: Partial<PhysicalInputSnapshot> = {}): PhysicalInputSnapshot {
  return { keys: new Set(), gamepadButtons: [], gamepadAxes: [], ...partial };
}

test("NaN/Infinity from a glitching gamepad never reaches gameplay values", () => {
  const router = new InputRouter(map);
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const s = snapshot({ gamepadAxes: [bad, bad, bad], gamepadButtons: [bad] });
    assert.equal(router.value("move", s), 0, `axis ${bad}`);
    assert.equal(router.getActionValue("move", s), 0, `axis ${bad}`);
    assert.equal(router.value("jump", s), 0, `button ${bad}`);
    assert.equal(router.isActionPressed("jump", s), false);
  }
  // A NaN axis does not poison other bindings on the same action.
  assert.equal(router.value("move", snapshot({ keys: new Set(["KeyD"]), gamepadAxes: [Number.NaN] })), 1);
});

test("a non-finite semantic action value reads as 0 instead of NaN", () => {
  const router = new InputRouter(map);
  router.setSemanticAction("move", "hold", Number.NaN);
  assert.equal(router.getActionValue("move"), 0);
  router.setSemanticAction("jump", "hold", Number.NaN);
  assert.equal(router.isActionPressed("jump"), false);
});

test("remap rejects malformed bindings and keeps the previous ones", () => {
  const router = new InputRouter(map);
  const malformed: unknown[] = [
    null,
    "Space",
    [],
    {},
    { kind: "key" },
    { kind: "key", code: "" },
    { kind: "key", code: "KeyJ", scale: "2" },
    { kind: "key", code: "KeyJ", scale: Number.NaN },
    { kind: "gamepad-button", button: -1 },
    { kind: "gamepad-button", button: 1.5 },
    { kind: "gamepad-axis" },
    { kind: "gamepad-axis", axis: 0, deadzone: 1 },
    { kind: "gamepad-axis", axis: 0, deadzone: -0.1 },
    { kind: "gamepad-axis", axis: 0, deadzone: "0.1" },
    { kind: "gamepad-axis", axis: 0, direction: "up" },
    { kind: "mouse", button: 0 },
  ];
  const before = router.exportMap();
  for (const binding of malformed) {
    assert.ok(describeInvalidInputBinding(binding), `should be invalid: ${JSON.stringify(binding)}`);
    assert.throws(
      () => router.remap("jump", [{ kind: "key", code: "KeyJ" }, binding as InputBinding]),
      /Invalid binding 1 for "jump"/,
      JSON.stringify(binding),
    );
  }
  assert.throws(() => router.remap("jump", "Space" as unknown as InputBinding[]), /must be an array/);
  assert.throws(() => router.remap("renamed.action", []), /Unknown input action/);
  assert.deepEqual(router.exportMap(), before, "a rejected remap must not change the map");

  router.remap("jump", [{ kind: "key", code: "KeyJ" }]);
  assert.equal(router.value("jump", snapshot({ keys: new Set(["KeyJ"]) })), 1);
});

test("every binding in the default player map is valid", () => {
  for (const action of DEFAULT_PLAYER_INPUT_MAP.actions) {
    for (const binding of action.bindings) {
      assert.equal(describeInvalidInputBinding(binding), undefined, `${action.id}: ${JSON.stringify(binding)}`);
    }
  }
});

test("property: values stay finite and in range for random snapshots, and buttons are 0 or 1", () => {
  const random = mulberry32(0x1a9e7);
  const router = new InputRouter(map);
  const samples = [0, 0.1, 0.19, 0.21, 0.5, 1, -0.1, -0.5, -1, 3, -3, Number.NaN, Number.POSITIVE_INFINITY];
  const pick = () => samples[Math.floor(random() * samples.length)]!;
  for (let index = 0; index < 2000; index += 1) {
    const keys = new Set<string>();
    for (const code of ["KeyD", "KeyA", "Space", "KeyZ"]) if (random() < 0.4) keys.add(code);
    const s = snapshot({ keys, gamepadAxes: [pick(), pick(), pick()], gamepadButtons: [pick()] });
    if (random() < 0.2) router.setSemanticAction("move", random() < 0.5 ? "hold" : "release", pick());
    const move = router.value("move", s);
    const moveAction = router.getActionValue("move", s);
    const jump = router.value("jump", s);
    const context = JSON.stringify({ keys: [...keys], axes: s.gamepadAxes, buttons: s.gamepadButtons });
    for (const value of [move, moveAction]) {
      assert.ok(Number.isFinite(value) && value >= -1 && value <= 1, `${value}: ${context}`);
    }
    assert.ok(jump === 0 || jump === 1, `${jump}: ${context}`);
    assert.equal(router.isActionPressed("jump", s), router.getActionValue("jump", s) === 1);
    router.endStep();
  }
});

test("property: an axis inside its deadzone contributes nothing, outside it contributes linearly", () => {
  const random = mulberry32(0xdead);
  for (let index = 0; index < 1000; index += 1) {
    const deadzone = Math.round(random() * 90) / 100;
    const raw = Math.round((random() * 2 - 1) * 100) / 100;
    const router = new InputRouter({
      schemaVersion: 1,
      actions: [{ id: "a", type: "axis", bindings: [{ kind: "gamepad-axis", axis: 0, deadzone }] }],
    });
    const value = router.value("a", snapshot({ gamepadAxes: [raw] }));
    const expected = Math.abs(raw) > deadzone ? raw : 0;
    assert.equal(value, expected, `raw=${raw} deadzone=${deadzone}`);
  }
});
