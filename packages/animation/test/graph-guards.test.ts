import assert from "node:assert/strict";
import test from "node:test";

import {
  AnimationGraphMachine,
  validateAnimationGraph,
  type AnimationGraphDefinition,
} from "../src/graph.js";

function base(): AnimationGraphDefinition {
  return {
    schemaVersion: 1,
    entryState: "idle",
    parameters: {
      speed: { type: "number", default: 0 },
      grounded: { type: "bool", default: true },
      jump: { type: "trigger" },
    },
    states: [
      { id: "idle", clipId: "idle" },
      { id: "walk", clipId: "walk" },
      { id: "run", clipId: "run" },
    ],
    transitions: [],
  };
}

test("set() rejects non-finite numbers so NaN cannot poison blend spaces or comparisons", () => {
  const machine = new AnimationGraphMachine(base());
  assert.throws(() => machine.set("speed", Number.NaN), /finite/);
  assert.throws(() => machine.set("speed", Number.POSITIVE_INFINITY), /finite/);
  assert.equal(machine.getParameter("speed"), 0);
});

test("parameter lookups ignore Object.prototype keys", () => {
  const machine = new AnimationGraphMachine(base());
  assert.throws(() => machine.set("toString", 1), /Unknown animation parameter/);
  assert.throws(() => machine.set("constructor", true), /Unknown animation parameter/);
  assert.equal(Object.hasOwn(machine.getParameters(), "toString"), false);
  const graph = base();
  graph.transitions.push({ id: "t", from: "idle", to: "walk", conditions: [{ parameter: "hasOwnProperty", op: "==", value: 1 }] });
  const codes = validateAnimationGraph(graph).map((d) => d.code);
  assert.ok(codes.includes("anim.condition.parameter.missing"), codes.join(","));
});

test("equal-priority transitions are ordered by code point, not host locale", () => {
  const graph = base();
  // localeCompare puts "a" before "B"; code-point order puts "B" (0x42) before "a" (0x61).
  graph.transitions.push(
    { id: "a-to-run", from: "idle", to: "run", conditions: [{ parameter: "speed", op: ">", value: 1 }] },
    { id: "B-to-walk", from: "idle", to: "walk", conditions: [{ parameter: "speed", op: ">", value: 1 }] },
  );
  const machine = new AnimationGraphMachine(graph);
  machine.set("speed", 2);
  assert.equal(machine.evaluate()?.transitionId, "B-to-walk");
});

test("validation reports bad parameter defaults, priorities, speeds and condition values", () => {
  const graph = base();
  graph.parameters.speed = { type: "number", default: true };
  graph.parameters.grounded = { type: "bool", default: 1 };
  graph.parameters.weird = { type: "float" as never };
  graph.states[1]!.speed = Number.NaN;
  graph.transitions.push(
    { id: "p", from: "idle", to: "walk", priority: Number.NaN, conditions: [{ parameter: "speed", op: ">", value: true }] },
    { id: "q", from: "idle", to: "run", conditions: [{ parameter: "grounded", op: "==", value: 3 }] },
    { id: "r", from: "idle", to: "run", conditions: [{ parameter: "speed", op: "~=" as never, value: 1 }] },
  );
  const codes = validateAnimationGraph(graph).map((d) => d.code).sort();
  for (const code of [
    "anim.parameter.default.type",
    "anim.parameter.type",
    "anim.state.speed.invalid",
    "anim.transition.priority.invalid",
    "anim.condition.value.type",
    "anim.condition.op.invalid",
  ]) {
    assert.ok(codes.includes(code), `missing ${code} in ${codes.join(",")}`);
  }
  assert.throws(() => new AnimationGraphMachine(graph), /Invalid animation graph/);
});

test("a valid graph still validates cleanly", () => {
  const graph = base();
  graph.states[1]!.speed = 1.5;
  graph.transitions.push(
    { id: "go", from: "idle", to: "walk", priority: 2, conditions: [{ parameter: "speed", op: ">=", value: 0.5 }] },
    { id: "hop", from: "*", to: "run", conditions: [{ parameter: "jump", op: "triggered" }, { parameter: "grounded", op: "==", value: true }] },
  );
  assert.deepEqual(validateAnimationGraph(graph), []);
});
