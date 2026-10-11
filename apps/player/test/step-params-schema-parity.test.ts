import assert from "node:assert/strict";
import test from "node:test";

import { runtimeStepStepSchema } from "@kinetra/verification";

import {
  MAX_STEP_DELTA_SECONDS,
  MAX_STEPS_PER_CALL,
  parseRuntimeStepParams,
} from "../src/step-params.js";

// The player (parseRuntimeStepParams) and the verification probe schema (runtimeStepStepSchema)
// each carry their own copy of the runtime.step bounds (36000 / 1). If they drift, a manifest
// validates and then fails mid-run with the player's raw TypeError (or the schema rejects a call
// the player would happily run). This pins both directions over a grid around every boundary.

function playerAccepts(steps: unknown, deltaSeconds: unknown): boolean {
  try {
    parseRuntimeStepParams({ steps, deltaSeconds });
    return true;
  } catch (error) {
    assert.ok(error instanceof TypeError, `player must reject with a TypeError, got ${String(error)}`);
    return false;
  }
}

function schemaAccepts(steps: unknown, deltaSeconds: unknown): boolean {
  const step: Record<string, unknown> = { type: "runtime.step" };
  if (steps !== undefined) step.steps = steps;
  if (deltaSeconds !== undefined) step.deltaSeconds = deltaSeconds;
  return runtimeStepStepSchema.safeParse(step).success;
}

const stepCandidates: unknown[] = [
  undefined,
  -1,
  0,
  1,
  2,
  1.5,
  MAX_STEPS_PER_CALL - 1,
  MAX_STEPS_PER_CALL,
  MAX_STEPS_PER_CALL + 1,
  MAX_STEPS_PER_CALL * 2,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  Number.MAX_SAFE_INTEGER,
  "1",
  true,
];

const deltaCandidates: unknown[] = [
  undefined,
  -1,
  0,
  Number.MIN_VALUE,
  1 / 60,
  0.5,
  MAX_STEP_DELTA_SECONDS - Number.EPSILON,
  MAX_STEP_DELTA_SECONDS,
  MAX_STEP_DELTA_SECONDS + Number.EPSILON,
  1.0001,
  60,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  "0.1",
  false,
];

test("the player and the probe schema agree on every steps/deltaSeconds combination (except steps: 0)", () => {
  let compared = 0;
  for (const steps of stepCandidates) {
    for (const deltaSeconds of deltaCandidates) {
      const player = playerAccepts(steps, deltaSeconds);
      const schema = schemaAccepts(steps, deltaSeconds);
      // `steps: 0` is the single deliberate difference: the player treats it as a legal no-op,
      // while a probe step that advances nothing is rejected as a mistake.
      if (steps === 0) {
        assert.equal(schema, false, `schema must reject steps:0 (delta ${String(deltaSeconds)})`);
        continue;
      }
      assert.equal(
        schema,
        player,
        `drift for steps=${String(steps)} deltaSeconds=${String(deltaSeconds)}: schema ${schema}, player ${player}`,
      );
      compared += 1;
    }
  }
  assert.ok(compared > 200, `grid shrank unexpectedly (${compared} combinations)`);
});

test("a schema-valid probe step is always accepted by the player (deterministic fuzz)", () => {
  // Small LCG so the run is reproducible without a seed dependency.
  let state = 0x2545f491;
  const next = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
  for (let index = 0; index < 2000; index += 1) {
    const steps = next() < 0.5 ? Math.floor(next() * (MAX_STEPS_PER_CALL * 1.2)) : next() * 100;
    const deltaSeconds = (next() * 1.2 - 0.1) * MAX_STEP_DELTA_SECONDS;
    if (schemaAccepts(steps, deltaSeconds)) {
      assert.equal(playerAccepts(steps, deltaSeconds), true, `steps=${steps} deltaSeconds=${deltaSeconds}`);
    }
    if (playerAccepts(steps, deltaSeconds) && steps !== 0) {
      assert.equal(schemaAccepts(steps, deltaSeconds), true, `steps=${steps} deltaSeconds=${deltaSeconds}`);
    }
  }
});

test("the exported bounds are the ones the schema's inclusive edges sit on", () => {
  assert.equal(schemaAccepts(MAX_STEPS_PER_CALL, MAX_STEP_DELTA_SECONDS), true);
  assert.equal(schemaAccepts(MAX_STEPS_PER_CALL + 1, undefined), false);
  assert.equal(schemaAccepts(undefined, MAX_STEP_DELTA_SECONDS + Number.EPSILON), false);
  assert.equal(playerAccepts(MAX_STEPS_PER_CALL + 1, undefined), false);
});
