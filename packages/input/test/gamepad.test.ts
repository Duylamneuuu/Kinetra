import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_PLAYER_INPUT_MAP,
  FakeGamepadSnapshotProvider,
  InputRouter,
  type PhysicalInputSnapshot,
} from "../src/index.js";

test("GamepadSnapshotProvider fake provider operates deterministically", () => {
  const provider = new FakeGamepadSnapshotProvider();
  assert.equal(provider.getSnapshot(), undefined);

  provider.setSnapshot({
    buttons: [1, 0, 0, 0, 0, 0, 0, 0, 0, 1],
    axes: [0.8, -0.9],
  });

  const snap = provider.getSnapshot();
  assert.ok(snap);
  assert.equal(snap.buttons[0], 1);
  assert.equal(snap.buttons[9], 1);
  assert.equal(snap.axes[0], 0.8);
  assert.equal(snap.axes[1], -0.9);
});

test("InputRouter resolves gamepad stick axes and deadzone deterministically", () => {
  const router = new InputRouter(DEFAULT_PLAYER_INPUT_MAP);

  // 1. Deadzone filtering: stick barely touched (0.05 < 0.15)
  const deadzoneSnapshot: PhysicalInputSnapshot = {
    keys: new Set(),
    gamepadButtons: [],
    gamepadAxes: [0.05, -0.08],
  };
  assert.equal(router.getActionValue("player.moveRight", deadzoneSnapshot), 0);
  assert.equal(router.getActionValue("player.moveLeft", deadzoneSnapshot), 0);
  assert.equal(router.getActionValue("player.moveForward", deadzoneSnapshot), 0);
  assert.equal(router.getActionValue("player.moveBackward", deadzoneSnapshot), 0);

  // 2. Active stick right & forward: axis 0 = 0.85, axis 1 = -0.9 (up is negative Y)
  const activeSnapshot: PhysicalInputSnapshot = {
    keys: new Set(),
    gamepadButtons: [],
    gamepadAxes: [0.85, -0.9],
  };
  assert.equal(router.getActionValue("player.moveRight", activeSnapshot), 0.85);
  assert.equal(router.getActionValue("player.moveLeft", activeSnapshot), 0);
  assert.equal(router.getActionValue("player.moveForward", activeSnapshot), 0.9);
  assert.equal(router.getActionValue("player.moveBackward", activeSnapshot), 0);

  // 3. Active stick left & backward: axis 0 = -0.75, axis 1 = 0.65
  const oppositeSnapshot: PhysicalInputSnapshot = {
    keys: new Set(),
    gamepadButtons: [],
    gamepadAxes: [-0.75, 0.65],
  };
  assert.equal(router.getActionValue("player.moveRight", oppositeSnapshot), 0);
  assert.equal(router.getActionValue("player.moveLeft", oppositeSnapshot), 0.75);
  assert.equal(router.getActionValue("player.moveForward", oppositeSnapshot), 0);
  assert.equal(router.getActionValue("player.moveBackward", oppositeSnapshot), 0.65);
});

test("InputRouter resolves gamepad buttons for pause, confirm, back, and d-pad", () => {
  const router = new InputRouter(DEFAULT_PLAYER_INPUT_MAP);

  const buttonSnapshot: PhysicalInputSnapshot = {
    keys: new Set(),
    gamepadButtons: [
      1, // button 0: A / South (jump, ui.confirm)
      1, // button 1: B / East (ui.back)
      0, 0, 0, 0, 0, 0, 0,
      1, // button 9: Start (game.pause)
      0, 0,
      1, // button 12: D-pad Up (player.moveForward)
      0,
      1, // button 14: D-pad Left (player.moveLeft)
      0,
    ],
    gamepadAxes: [],
  };

  assert.equal(router.isActionPressed("player.jump", buttonSnapshot), true);
  assert.equal(router.isActionPressed("game.pause", buttonSnapshot), true);
  assert.equal(router.isActionPressed("ui.confirm", buttonSnapshot), true);
  assert.equal(router.isActionPressed("ui.back", buttonSnapshot), true);
  assert.equal(router.getActionValue("player.moveForward", buttonSnapshot), 1);
  assert.equal(router.getActionValue("player.moveLeft", buttonSnapshot), 1);
  assert.equal(router.getActionValue("player.moveRight", buttonSnapshot), 0);
  assert.equal(router.getActionValue("player.moveBackward", buttonSnapshot), 0);
});

test("Input remapping changes semantic bindings without altering action semantics", () => {
  const router = new InputRouter(DEFAULT_PLAYER_INPUT_MAP);

  // Default: KeyD moves right
  const defaultKeySnapshot: PhysicalInputSnapshot = {
    keys: new Set(["KeyD"]),
    gamepadButtons: [],
    gamepadAxes: [],
  };
  assert.equal(router.getActionValue("player.moveRight", defaultKeySnapshot), 1);

  // Remap player.moveRight to KeyL and Gamepad button 5 (Right Bumper)
  router.remap("player.moveRight", [
    { kind: "key", code: "KeyL", scale: 1 },
    { kind: "gamepad-button", button: 5, scale: 1 },
  ]);

  // Old KeyD no longer triggers
  assert.equal(router.getActionValue("player.moveRight", defaultKeySnapshot), 0);

  // New KeyL triggers
  const remappedKeySnapshot: PhysicalInputSnapshot = {
    keys: new Set(["KeyL"]),
    gamepadButtons: [],
    gamepadAxes: [],
  };
  assert.equal(router.getActionValue("player.moveRight", remappedKeySnapshot), 1);

  // New Gamepad button 5 triggers
  const remappedPadSnapshot: PhysicalInputSnapshot = {
    keys: new Set(),
    gamepadButtons: [0, 0, 0, 0, 0, 1],
    gamepadAxes: [],
  };
  assert.equal(router.getActionValue("player.moveRight", remappedPadSnapshot), 1);
});
