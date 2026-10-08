import assert from "node:assert/strict";
import test from "node:test";

import {
  AnimationGraphMachine,
  evaluateBlendSpace,
  validateAnimationGraph,
  type AnimationGraphDefinition,
  type BlendSpaceDefinition,
} from "../src/index.js";

const locomotion: BlendSpaceDefinition = {
  schemaVersion: 1,
  kind: "1d",
  id: "locomotion",
  parameter: "speed",
  samples: [
    { clipId: "idle", position: 0 },
    { clipId: "walk", position: 1.5 },
    { clipId: "run", position: 4 },
  ],
};

const strafe: BlendSpaceDefinition = {
  schemaVersion: 1,
  kind: "2d",
  id: "strafe",
  parameters: ["vx", "vz"],
  samples: [
    { clipId: "idle", position: [0, 0] },
    { clipId: "left", position: [-1, 0] },
    { clipId: "right", position: [1, 0] },
    { clipId: "fwd", position: [0, 1] },
  ],
};

function graph(): AnimationGraphDefinition {
  return {
    schemaVersion: 1,
    entryState: "stand",
    parameters: {
      speed: { type: "number", default: 0 },
      vx: { type: "number", default: 0 },
      vz: { type: "number", default: 0 },
      moving: { type: "bool", default: false },
      jump: { type: "trigger" },
    },
    blendSpaces: [locomotion, strafe],
    states: [
      { id: "stand", clipId: "idle" },
      { id: "move", blendSpaceId: "locomotion", speed: 1.25 },
      { id: "combat", blendSpaceId: "strafe" },
      { id: "leap", clipId: "jump", loop: false },
    ],
    transitions: [
      { id: "start", from: "stand", to: "move", conditions: [{ parameter: "speed", op: ">", value: 0.1 }], blendSeconds: 0.2 },
      { id: "stop", from: "move", to: "stand", conditions: [{ parameter: "speed", op: "<=", value: 0.1 }], blendSeconds: 0.3 },
      { id: "to-leap", from: "*", to: "leap", conditions: [{ parameter: "jump", op: "triggered" }], blendSeconds: 0.1 },
    ],
  };
}

function codes(g: AnimationGraphDefinition): string[] {
  return validateAnimationGraph(g).map((d) => d.code);
}

test("a graph whose states reference declared blend spaces validates", () => {
  assert.deepEqual(validateAnimationGraph(graph()), []);
});

test("a graph without blendSpaces still validates exactly as before", () => {
  const g = graph();
  delete g.blendSpaces;
  g.states = g.states.filter((s) => s.blendSpaceId === undefined);
  g.transitions = g.transitions.filter((t) => t.to !== "move" && t.from !== "move");
  assert.deepEqual(validateAnimationGraph(g), []);
});

test("unknown blendSpaceId is reported with the anim.state.blendSpace.unknown code and remediation", () => {
  const g = graph();
  g.states[1]!.blendSpaceId = "nope";
  const diagnostics = validateAnimationGraph(g);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]!.code, "anim.state.blendSpace.unknown");
  assert.match(diagnostics[0]!.message, /"nope"/);
  assert.ok(diagnostics[0]!.remediation);
});

test("a state cannot set both clipId and blendSpaceId, nor an empty blendSpaceId", () => {
  const both = graph();
  both.states[1]!.clipId = "walk";
  assert.deepEqual(codes(both), ["anim.state.clipAndBlendSpace"]);

  const empty = graph();
  empty.states[1]!.blendSpaceId = "";
  assert.deepEqual(codes(empty), ["anim.state.blendSpace.empty"]);

  const none = graph();
  delete none.states[0]!.clipId;
  assert.deepEqual(codes(none), ["anim.state.clip.empty"]);
});

test("blend-space axes must be number graph parameters", () => {
  const missing = graph();
  delete missing.parameters.speed;
  // locomotion is driven by speed; the `start`/`stop` conditions also lose their parameter.
  assert.ok(codes(missing).includes("anim.state.blendSpace.parameter"));

  const wrongType = graph();
  wrongType.parameters.speed = { type: "bool" };
  assert.ok(codes(wrongType).includes("anim.state.blendSpace.parameter"));

  const trigger = graph();
  trigger.parameters.vz = { type: "trigger" };
  assert.ok(codes(trigger).includes("anim.state.blendSpace.parameter"));
});

test("invalid or duplicate blend-space definitions surface their own diagnostics", () => {
  const bad = graph();
  bad.blendSpaces = [{ ...locomotion, samples: [{ clipId: "idle", position: 0 }, { clipId: "walk", position: 0 }] } as BlendSpaceDefinition, strafe];
  const badCodes = codes(bad);
  assert.ok(badCodes.some((c) => c.startsWith("anim.blendSpace.")));
  // The broken space is not registered, so the state that uses it is flagged too.
  assert.ok(badCodes.includes("anim.state.blendSpace.unknown"));

  const dup = graph();
  dup.blendSpaces = [locomotion, locomotion, strafe];
  assert.deepEqual(codes(dup), ["anim.blendSpace.duplicate"]);
});

test("malformed graph.blendSpaces never throws", () => {
  const g = graph();
  (g as unknown as { blendSpaces: unknown }).blendSpaces = { not: "an array" };
  assert.doesNotThrow(() => validateAnimationGraph(g));
  assert.ok(codes(g).includes("anim.graph.blendSpaces.type"));

  const nulls = graph();
  (nulls as unknown as { blendSpaces: unknown[] }).blendSpaces = [null, 3, "x"];
  assert.doesNotThrow(() => validateAnimationGraph(nulls));
  assert.ok(codes(nulls).includes("anim.blendSpace.invalid"));
});

test("the machine refuses to construct from an invalid blend-space graph", () => {
  const g = graph();
  g.states[1]!.blendSpaceId = "nope";
  assert.throws(() => new AnimationGraphMachine(g), /unknown blend space "nope"/);
});

test("getBlendSpaceInput tracks graph number parameters for the current state", () => {
  const machine = new AnimationGraphMachine(graph());
  assert.equal(machine.getBlendSpace(), undefined, "clip state has no blend space");
  assert.equal(machine.getBlendSpaceInput(), undefined);
  assert.deepEqual(machine.getBlendSpaceInput("move"), { speed: 0 });
  assert.deepEqual(machine.getBlendSpaceInput("combat"), { vx: 0, vz: 0 });

  machine.set("speed", 2);
  machine.set("vx", -0.5);
  assert.deepEqual(machine.getBlendSpaceInput("move"), { speed: 2 });
  assert.deepEqual(machine.getBlendSpaceInput("combat"), { vx: -0.5, vz: 0 });
  assert.equal(machine.getBlendSpaceInput("stand"), undefined);
  assert.equal(machine.getBlendSpaceInput("missing"), undefined);
});

test("graph parameter drives blend-space weights through evaluateBlendSpace", () => {
  const machine = new AnimationGraphMachine(graph());
  machine.set("speed", 0.75);
  const transition = machine.evaluate();
  assert.equal(transition?.to, "move");
  assert.equal(transition?.blendSeconds, 0.2);
  assert.equal(machine.state, "move");

  const space = machine.getBlendSpace()!;
  assert.equal(space.id, "locomotion");
  const weights = evaluateBlendSpace(space, machine.getParameters());
  assert.deepEqual(weights.map((w) => w.clipId).sort(), ["idle", "walk"]);
  assert.ok(Math.abs(weights.find((w) => w.clipId === "walk")!.weight - 0.5) < 1e-9);

  machine.set("speed", 4);
  assert.deepEqual(evaluateBlendSpace(space, machine.getParameters()), [{ clipId: "run", weight: 1 }]);
});

test("transitions out of a blend-space state behave like any other transition", () => {
  const machine = new AnimationGraphMachine(graph());
  machine.set("speed", 1);
  assert.equal(machine.evaluate()?.transitionId, "start");
  machine.set("speed", 0);
  const out = machine.evaluate();
  assert.equal(out?.transitionId, "stop");
  assert.equal(out?.blendSeconds, 0.3);
  assert.equal(machine.getBlendSpaceInput(), undefined, "stand is a clip state again");
  machine.set("speed", 2);
  machine.trigger("jump");
  // priority tie: ids sort by code point, `start` before `to-leap`
  assert.equal(machine.evaluate()?.transitionId, "start");
});

test("the machine's cloned blend spaces are isolated from later mutation of the source", () => {
  const source = graph();
  const machine = new AnimationGraphMachine(source);
  (source.blendSpaces![0] as { id: string }).id = "mutated";
  assert.equal(machine.getBlendSpace("move")?.id, "locomotion");
});
