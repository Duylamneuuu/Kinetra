import assert from "node:assert/strict";
import test from "node:test";

import { AnimationGraphMachine, validateAnimationGraph, type AnimationGraphDefinition } from "../src/graph.js";

function base(): AnimationGraphDefinition {
  return {
    schemaVersion: 1,
    entryState: "a",
    parameters: { speed: { type: "number" } },
    states: [
      { id: "a", clipId: "x" },
      { id: "b", clipId: "y" },
    ],
    transitions: [{ id: "t", from: "a", to: "b", conditions: [{ parameter: "speed", op: ">", value: 1 }] }],
  };
}

function codesOf(graph: unknown): string[] {
  return validateAnimationGraph(graph as AnimationGraphDefinition).map((d) => d.code);
}

// Graphs come from project files and IPC, so a structurally broken one must produce
// diagnostics (like validateBlendSpace does) instead of a bare TypeError.
const cases: Array<[string, (g: Record<string, unknown>) => void, string]> = [
  ["parameters missing", (g) => { delete g.parameters; }, "anim.graph.parameters.type"],
  ["parameters null", (g) => { g.parameters = null; }, "anim.graph.parameters.type"],
  ["parameters an array", (g) => { g.parameters = []; }, "anim.graph.parameters.type"],
  ["states missing", (g) => { delete g.states; }, "anim.graph.states.type"],
  ["states not an array", (g) => { g.states = {}; }, "anim.graph.states.type"],
  ["state null", (g) => { g.states = [null]; }, "anim.state.invalid"],
  ["state id not a string", (g) => { g.states = [{ id: 7, clipId: "x" }]; }, "anim.state.id.invalid"],
  ["transitions missing", (g) => { delete g.transitions; }, "anim.graph.transitions.type"],
  ["transition null", (g) => { g.transitions = [null]; }, "anim.transition.invalid"],
  ["transition without conditions", (g) => { g.transitions = [{ id: "t", from: "a", to: "b" }]; }, "anim.transition.conditions.type"],
  ["condition null", (g) => { g.transitions = [{ id: "t", from: "a", to: "b", conditions: [null] }]; }, "anim.condition.invalid"],
];

for (const [name, mutate, code] of cases) {
  test(`validateAnimationGraph reports ${code} instead of throwing when ${name}`, () => {
    const graph = base() as unknown as Record<string, unknown>;
    mutate(graph);
    assert.doesNotThrow(() => validateAnimationGraph(graph as unknown as AnimationGraphDefinition));
    assert.ok(codesOf(graph).includes(code), `expected ${code}, got ${codesOf(graph).join(",")}`);
  });
}

test("validateAnimationGraph rejects a non-object graph with a diagnostic", () => {
  for (const value of [null, undefined, 3, "graph", []]) {
    assert.deepEqual(codesOf(value), ["anim.graph.invalid"]);
  }
});

test("AnimationGraphMachine constructor throws a descriptive Error (not a TypeError) for a broken graph", () => {
  const graph = base() as unknown as Record<string, unknown>;
  graph.transitions = [{ id: "t", from: "a", to: "b" }];
  assert.throws(
    () => new AnimationGraphMachine(graph as unknown as AnimationGraphDefinition),
    (error: unknown) => error instanceof Error && !(error instanceof TypeError) && /Invalid animation graph/.test(error.message),
  );
});

test("a well-formed graph still validates clean", () => {
  assert.deepEqual(validateAnimationGraph(base()), []);
});
