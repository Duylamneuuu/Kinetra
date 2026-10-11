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

function codes(graph: unknown): string[] {
  return validateAnimationGraph(graph as AnimationGraphDefinition).map((d) => d.code);
}

test("a state without a string id is a diagnostic, not a silently accepted undefined-named state", () => {
  for (const id of [undefined, "", 5, null]) {
    const graph = base();
    (graph.states as Array<Record<string, unknown>>)[1] = id === undefined ? { clipId: "walk" } : { id, clipId: "walk" };
    assert.ok(codes(graph).includes("anim.state.id.empty"), `id ${String(id)} must be reported`);
  }
});

test("an id-less state cannot make a missing entryState or transition endpoints look valid", () => {
  const graph = base();
  delete graph.entryState;
  (graph.states as Array<Record<string, unknown>>).push({ clipId: "orphan" });
  (graph.transitions as Array<Record<string, unknown>>).push({ id: "t2", conditions: [] });
  const found = codes(graph);
  assert.ok(found.includes("anim.state.id.empty"));
  assert.ok(found.includes("anim.entry.missing"), "entryState undefined must not match an id-less state");
  assert.ok(found.includes("anim.transition.from.missing"));
  assert.ok(found.includes("anim.transition.to.missing"));
  assert.throws(() => new AnimationGraphMachine(graph as unknown as AnimationGraphDefinition), /Invalid animation graph/);
});

test("a transition without a non-empty string id is reported", () => {
  for (const id of [undefined, "", 7]) {
    const graph = base();
    const transition: Record<string, unknown> = { from: "idle", to: "walk", conditions: [] };
    if (id !== undefined) transition.id = id;
    (graph.transitions as unknown[]).push(transition);
    assert.ok(codes(graph).includes("anim.transition.id.empty"), `transition id ${String(id)} must be reported`);
  }
});

test("a well-formed graph still validates clean", () => {
  assert.deepEqual(codes(base()), []);
});
