import assert from "node:assert/strict";
import test from "node:test";

import { PlayerInputError, decidePlayerInput, resolveInputMagnitude } from "../src/input-event.js";
import { KeyTracker } from "../src/key-tracker.js";

test("resolveInputMagnitude reads a number, a vector's first component, or defaults to 1", () => {
  assert.equal(resolveInputMagnitude(0.5, "a"), 0.5);
  assert.equal(resolveInputMagnitude(-2, "a"), -2);
  assert.equal(resolveInputMagnitude([0.25, 9], "a"), 0.25);
  assert.equal(resolveInputMagnitude(undefined, "a"), 1);
});

test("resolveInputMagnitude rejects NaN and Infinity instead of forwarding them to the motor", () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.throws(() => resolveInputMagnitude(bad, "player.moveRight"), /player\.moveRight.*non-finite/);
    assert.throws(() => resolveInputMagnitude([bad, 0], "player.moveRight"), /non-finite/);
  }
});

test("a press/hold while paused is blocked but a release is still delivered", () => {
  assert.deepEqual(decidePlayerInput({ action: "jump", phase: "press" }, true), { kind: "blocked" });
  assert.deepEqual(decidePlayerInput({ action: "jump", phase: "hold" }, true), { kind: "blocked" });
  assert.deepEqual(decidePlayerInput({ action: "jump", phase: "release" }, true), { kind: "release-only" });
});

test("a release while paused does not need a finite value", () => {
  assert.deepEqual(decidePlayerInput({ action: "jump", phase: "release", value: Number.NaN }, true), {
    kind: "release-only",
  });
});

test("an input while running yields its magnitude and validates it", () => {
  assert.deepEqual(decidePlayerInput({ action: "jump", phase: "press", value: 0.75 }, false), {
    kind: "apply",
    magnitude: 0.75,
  });
  assert.throws(() => decidePlayerInput({ action: "jump", phase: "press", value: Number.NaN }, false), /non-finite/);
});

test("a release while running is never rejected for its value and carries magnitude 0", () => {
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, 0.5, undefined]) {
    assert.deepEqual(decidePlayerInput({ action: "jump", phase: "release", value }, false), {
      kind: "apply",
      magnitude: 0,
    });
  }
});

test("a non-finite value is a structured PlayerInputError with a code and a hint", () => {
  assert.throws(
    () => resolveInputMagnitude(Number.NaN, "player.moveLeft"),
    (error: unknown) =>
      error instanceof PlayerInputError &&
      error.code === "runtime.input.nonFinite" &&
      typeof error.hint === "string",
  );
});

test("KeyTracker records keys, clears them on blur, and removes its listeners on dispose", () => {
  const target = new EventTarget();
  const tracker = new KeyTracker({
    addEventListener: (type, listener) => target.addEventListener(type, listener as EventListener),
    removeEventListener: (type, listener) => target.removeEventListener(type, listener as EventListener),
  });
  const fire = (type: string, code?: string) => {
    const event = new Event(type);
    if (code !== undefined) Object.defineProperty(event, "code", { value: code });
    target.dispatchEvent(event);
  };

  fire("keydown", "KeyW");
  fire("keydown", "ShiftLeft");
  assert.deepEqual([...tracker.keys].sort(), ["KeyW", "ShiftLeft"]);
  fire("keyup", "KeyW");
  assert.deepEqual([...tracker.keys], ["ShiftLeft"]);

  fire("blur");
  assert.equal(tracker.keys.size, 0, "blur forgets keys whose keyup went to another window");

  tracker.dispose();
  fire("keydown", "KeyA");
  assert.equal(tracker.keys.size, 0, "a disposed tracker ignores further events");
  tracker.dispose();
});
