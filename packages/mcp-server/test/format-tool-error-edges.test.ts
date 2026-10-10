import assert from "node:assert/strict";
import test from "node:test";

import { formatToolError } from "../src/index.js";

function withFields(message: string, fields: Record<string, unknown>): Error {
  return Object.assign(new Error(message), fields);
}

test("formatToolError keeps a plain Error message when code is not a string and issues are absent", () => {
  assert.equal(formatToolError(withFields("boom", { code: 42 })), "boom");
  assert.equal(formatToolError(withFields("boom", { code: undefined })), "boom");
  assert.equal(formatToolError(withFields("boom", { remediation: "ignored" })), "boom");
});

test("formatToolError ignores empty or malformed issue lists instead of emitting half-structured JSON", () => {
  assert.equal(formatToolError(withFields("empty", { issues: [] })), "empty");
  assert.equal(formatToolError(withFields("not array", { issues: "nope" })), "not array");
  assert.equal(formatToolError(withFields("null item", { issues: [null] })), "null item");
  // One bad item discards the whole list: a partial list would read as the complete one.
  assert.equal(
    formatToolError(
      withFields("mixed", {
        issues: [
          { path: "a", code: "x", message: "ok" },
          { path: "b", code: "y" },
        ],
      }),
    ),
    "mixed",
  );
  assert.equal(
    formatToolError(withFields("bad types", { issues: [{ path: 1, code: "x", message: "m" }] })),
    "bad types",
  );
});

test("formatToolError still reports the code when the issue list is malformed", () => {
  const body = JSON.parse(
    formatToolError(withFields("coded", { code: "E_X", issues: [{ path: "a" }] })),
  ) as Record<string, unknown>;
  assert.deepEqual(body, { code: "E_X", message: "coded" });
});

test("formatToolError copies only the known issue fields and keeps remediation when it is a string", () => {
  const body = JSON.parse(
    formatToolError(
      withFields("invalid project", {
        issues: [
          { path: "scenes.0", code: "scene.id", message: "bad id", remediation: "use scene_*", secret: "x" },
          { path: "scenes.1", code: "scene.name", message: "bad name", remediation: 7 },
        ],
        remediation: "fix it",
      }),
    ),
  ) as {
    code?: string;
    message: string;
    remediation: string;
    issues: Array<Record<string, unknown>>;
  };
  assert.equal(body.code, undefined);
  assert.equal(body.remediation, "fix it");
  assert.deepEqual(body.issues, [
    { path: "scenes.0", code: "scene.id", message: "bad id", remediation: "use scene_*" },
    { path: "scenes.1", code: "scene.name", message: "bad name" },
  ]);
});

test("formatToolError stringifies non-Error throwables", () => {
  assert.equal(formatToolError(undefined), "undefined");
  assert.equal(formatToolError(null), "null");
  assert.equal(formatToolError(404), "404");
  assert.equal(formatToolError({ toString: () => "custom" }), "custom");
});
