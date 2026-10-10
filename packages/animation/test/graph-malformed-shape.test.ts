import assert from "node:assert/strict";
import test from "node:test";

import {
  AnimationGraphMachine,
  validateAnimationGraph,
  type AnimationGraphDefinition,
} from "../src/graph.js";

function base(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    entryState: "idle",
    parameters: { speed: { type: "number", default: 0 } },
    states: [
      { id: "idle", clipId: "idle" },
      { id: "walk", clipId: "walk" },
    ],
    transitions: [
      { id: "go", from: "idle", to: "walk", conditions: [{ parameter: "speed", op: ">", value: 1 }] },
    ],
  };
}

function validate(graph: unknown) {
  return validateAnimationGraph(graph as AnimationGraphDefinition);
}

function codes(graph: unknown): string[] {
  return validate(graph).map((d) => d.code);
}

test("a well-formed graph still validates clean", () => {
  assert.deepEqual(validate(base()), []);
});

test("validateAnimationGraph reports a non-object graph instead of throwing", () => {
  for (const value of [null, undefined, 3, "graph", []]) {
    assert.deepEqual(codes(value), ["anim.graph.invalid"]);
  }
});

test("validateAnimationGraph reports wrong top-level containers instead of throwing", () => {
  assert.ok(codes({ ...base(), parameters: null }).includes("anim.graph.parameters.type"));
  assert.ok(codes({ ...base(), parameters: [] }).includes("anim.graph.parameters.type"));
  assert.ok(codes({ ...base(), states: null }).includes("anim.graph.states.type"));
  assert.ok(codes({ ...base(), transitions: "none" }).includes("anim.graph.transitions.type"));
  const { parameters: _parameters, ...withoutParameters } = base();
  assert.ok(codes(withoutParameters).includes("anim.graph.parameters.type"));
});

test("validateAnimationGraph reports malformed states, transitions and conditions instead of throwing", () => {
  assert.ok(codes({ ...base(), states: [null, { id: "idle", clipId: "idle" }] }).includes("anim.state.invalid"));
  assert.ok(codes({ ...base(), transitions: [null] }).includes("anim.transition.invalid"));
  assert.ok(
    codes({ ...base(), transitions: [{ id: "go", from: "idle", to: "walk" }] }).includes(
      "anim.transition.conditions.type",
    ),
  );
  assert.ok(
    codes({
      ...base(),
      transitions: [{ id: "go", from: "idle", to: "walk", conditions: [null, 7] }],
    }).includes("anim.condition.invalid"),
  );
});

test("a graph with a malformed shape is rejected by the machine with a diagnostic message", () => {
  assert.throws(
    () => new AnimationGraphMachine({ ...base(), transitions: [{ id: "go", from: "idle", to: "walk" }] } as unknown as AnimationGraphDefinition),
    /Invalid animation graph: .*conditions must be an array/,
  );
});
