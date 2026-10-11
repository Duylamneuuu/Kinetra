import assert from "node:assert/strict";
import test from "node:test";

import {
  cloneProject,
  MAX_JSON_DEPTH,
  ProjectValidationError,
  validateProject,
  type ProjectDocument,
} from "../src/index.js";

function project(data: unknown, metadata?: unknown): ProjectDocument {
  return {
    schemaVersion: 1,
    projectId: "p",
    name: "Depth",
    scenes: [{ id: "s", name: "S", entities: [{ id: "e", name: "E", components: { data: data as never } }] }],
    ...(metadata !== undefined ? { metadata: metadata as never } : {}),
  } as ProjectDocument;
}

/** `levels` nested containers around a leaf: nest(1) is `{ child: 1 }`. */
function nest(levels: number, kind: "object" | "array" = "object"): unknown {
  let value: unknown = 1;
  for (let i = 0; i < levels; i += 1) value = kind === "object" ? { child: value } : [value];
  return value;
}

test(`component JSON accepts exactly ${MAX_JSON_DEPTH} nested containers and rejects one more (#205)`, () => {
  assert.equal(MAX_JSON_DEPTH, 512);
  for (const kind of ["object", "array"] as const) {
    assert.deepEqual(validateProject(project(nest(MAX_JSON_DEPTH - 1, kind))), [], `${kind} ${MAX_JSON_DEPTH - 1}`);
    assert.deepEqual(validateProject(project(nest(MAX_JSON_DEPTH, kind))), [], `${kind} ${MAX_JSON_DEPTH}`);
    assert.deepEqual(
      validateProject(project(nest(MAX_JSON_DEPTH + 1, kind))).map((issue) => issue.code),
      ["component.value.not-json"],
      `${kind} ${MAX_JSON_DEPTH + 1}`,
    );
  }
});

test("project metadata follows the same depth bound", () => {
  assert.deepEqual(validateProject(project(1, nest(MAX_JSON_DEPTH))), []);
  const issues = validateProject(project(1, nest(MAX_JSON_DEPTH + 1)));
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.path, "metadata");
});

test("cloneProject on an unvalidated, absurdly deep document throws a structured ProjectValidationError, not a raw RangeError", () => {
  const deep = project(nest(200_000));
  let thrown: unknown;
  try {
    cloneProject(deep);
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof ProjectValidationError, `expected ProjectValidationError, got ${String(thrown)}`);
  assert.deepEqual(
    thrown.issues.map((issue) => issue.code),
    ["project.json.too-deep"],
  );
  assert.ok(thrown.cause instanceof RangeError, "the original RangeError is kept as cause");
});

test("cloneProject still clones a valid document deeply and independently", () => {
  const source = project(nest(MAX_JSON_DEPTH));
  const copy = cloneProject(source);
  assert.deepEqual(copy, source);
  assert.notEqual(copy.scenes[0], source.scenes[0]);
});
