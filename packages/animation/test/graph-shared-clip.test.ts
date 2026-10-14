import assert from "node:assert/strict";
import test from "node:test";

import { analyzeAnimationGraph, validateAnimationGraph, type AnimationGraphDefinition } from "../src/graph.js";

function idleToLocomotion(overrides: { blendSeconds?: number } = {}): AnimationGraphDefinition {
  return {
    schemaVersion: 1,
    entryState: "idle",
    parameters: { speed: { type: "number", default: 0 } },
    blendSpaces: [
      {
        schemaVersion: 1,
        kind: "1d",
        id: "locomotion",
        parameter: "speed",
        samples: [
          { clipId: "idle", position: 0 },
          { clipId: "walk", position: 1 },
          { clipId: "run", position: 3 },
        ],
      },
    ],
    states: [
      { id: "idle", clipId: "idle" },
      { id: "locomotion", blendSpaceId: "locomotion" },
      { id: "wave", clipId: "wave" },
    ],
    transitions: [
      {
        id: "start",
        from: "idle",
        to: "locomotion",
        conditions: [{ parameter: "speed", op: ">", value: 0.1 }],
        ...(overrides.blendSeconds === undefined ? {} : { blendSeconds: overrides.blendSeconds }),
      },
      { id: "stop", from: "locomotion", to: "idle", conditions: [{ parameter: "speed", op: "<=", value: 0.1 }] },
      { id: "greet", from: "idle", to: "wave", conditions: [{ parameter: "speed", op: "<", value: -1 }] },
    ],
  };
}

test("analyzeAnimationGraph reports idle -> locomotion sharing the idle clip as a cut", () => {
  const graph = idleToLocomotion({ blendSeconds: 0.3 });
  assert.deepEqual(validateAnimationGraph(graph), [], "the graph itself is valid");
  const warnings = analyzeAnimationGraph(graph);
  assert.equal(warnings.length, 1);
  const [warning] = warnings;
  assert.equal(warning?.code, "anim.graph.transition.sharedClipCut");
  assert.match(warning?.message ?? "", /Transition "start" \(idle -> locomotion\)/);
  assert.match(warning?.message ?? "", /"idle"/);
  assert.match(warning?.message ?? "", /0\.3s/);
  assert.ok(warning?.remediation);
});

test("analyzeAnimationGraph uses the default 0.15 s blend when blendSeconds is omitted", () => {
  const warnings = analyzeAnimationGraph(idleToLocomotion());
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]?.message ?? "", /0\.15s/);
});

test("analyzeAnimationGraph stays quiet when the cut is intended (blendSeconds 0)", () => {
  assert.deepEqual(analyzeAnimationGraph(idleToLocomotion({ blendSeconds: 0 })), []);
});

test("analyzeAnimationGraph ignores transitions that do not share a clip or do not enter a blend space", () => {
  const graph = idleToLocomotion({ blendSeconds: 0.3 });
  // locomotion -> idle enters a clip state (the runtime crossfades that), idle -> wave shares nothing.
  assert.deepEqual(
    analyzeAnimationGraph(graph).map((w) => w.message.match(/Transition "([^"]+)"/)?.[1]),
    ["start"],
  );
});

test("analyzeAnimationGraph reports blend space -> blend space overlap once, with sorted clip names", () => {
  const graph = idleToLocomotion({ blendSeconds: 0.2 });
  graph.blendSpaces!.push({
    schemaVersion: 1,
    kind: "1d",
    id: "sneak",
    parameter: "speed",
    samples: [
      { clipId: "walk", position: 0 },
      { clipId: "run", position: 1 },
      { clipId: "sprint", position: 2 },
    ],
  });
  graph.states.push({ id: "sneak", blendSpaceId: "sneak" });
  graph.transitions.push({ id: "sneak-in", from: "locomotion", to: "sneak", conditions: [] });
  const sneak = analyzeAnimationGraph(graph).find((w) => w.message.includes('"sneak-in"'));
  assert.ok(sneak);
  assert.match(sneak.message, /"run", "walk"/);
  assert.doesNotMatch(sneak.message, /sprint/);
});

test("analyzeAnimationGraph never throws and returns [] for an invalid graph", () => {
  assert.deepEqual(analyzeAnimationGraph(null as unknown as AnimationGraphDefinition), []);
  assert.deepEqual(analyzeAnimationGraph({ schemaVersion: 1 } as unknown as AnimationGraphDefinition), []);
  const broken = idleToLocomotion({ blendSeconds: 0.3 });
  broken.entryState = "missing";
  assert.deepEqual(analyzeAnimationGraph(broken), []);
});
