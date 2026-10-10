import assert from "node:assert/strict";
import test from "node:test";

import { stableId, type ProjectDocument } from "@kinetra/project-model";

import { KinetraAgentService } from "../src/index.js";

function fixture(): ProjectDocument {
  return {
    schemaVersion: 1,
    projectId: stableId("project", "initial-revision-fixture"),
    name: "Initial revision fixture",
    scenes: [
      {
        id: stableId("scene", "initial-revision-main"),
        name: "Main",
        entities: [
          {
            id: stableId("entity", "initial-revision-root"),
            name: "Root",
            components: {
              Transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
            },
          },
        ],
      },
    ],
  };
}

test("KinetraAgentService starts at revision 0 by default and honours a valid initialRevision", () => {
  assert.equal(new KinetraAgentService(fixture()).bus.revision, 0);
  assert.equal(new KinetraAgentService(fixture(), { initialRevision: 0 }).bus.revision, 0);
  assert.equal(new KinetraAgentService(fixture(), { initialRevision: 41 }).bus.revision, 41);
  assert.equal(
    new KinetraAgentService(fixture(), { initialRevision: Number.MAX_SAFE_INTEGER }).bus.revision,
    Number.MAX_SAFE_INTEGER,
  );
});

test("KinetraAgentService rejects a NaN/negative/fractional/non-numeric initialRevision with a RangeError", () => {
  for (const bad of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, "3", true]) {
    assert.throws(
      () => new KinetraAgentService(fixture(), { initialRevision: bad as unknown as number }),
      (error: unknown) => {
        assert.ok(error instanceof RangeError, `expected RangeError for ${String(bad)}`);
        assert.match((error as Error).message, /initialRevision must be a non-negative safe integer/);
        return true;
      },
      `initialRevision ${String(bad)}`,
    );
  }
});

test("a rejected initialRevision does not mutate the project passed in", () => {
  const project = fixture();
  const before = JSON.stringify(project);
  assert.throws(() => new KinetraAgentService(project, { initialRevision: -5 }), RangeError);
  assert.equal(JSON.stringify(project), before);
});
