import assert from "node:assert/strict";
import test from "node:test";

import { listAcceptanceOperations } from "../src/acceptance-catalog.js";
import { acceptanceStepSchema } from "../src/types.js";

test("acceptance catalog lists every manifest step and its required fields", () => {
  const operations = listAcceptanceOperations();

  assert.equal(operations.length, acceptanceStepSchema.options.length);
  assert.deepEqual(
    operations.map((operation) => operation.type),
    [
      "animation.play",
      "animation.stop",
      "assert.equal",
      "assert.logAbsent",
      "assert.metricMax",
      "assert.metricMin",
      "assert.near",
      "assert.screenshotSha256",
      "assert.screenshotValidPng",
      "asset.register",
      "audio.play",
      "audio.setBusGain",
      "audio.setBusMuted",
      "audio.stop",
      "input",
      "navigation.bake",
      "navigation.closestPoint",
      "navigation.computePath",
      "navigation.load",
      "runtime.pause",
      "runtime.resume",
      "runtime.start",
      "runtime.step",
      "runtime.stop",
      "save.capture",
      "save.load",
      "wait",
    ],
  );
  assert.equal(new Set(operations.map((operation) => operation.type)).size, operations.length);
  assert.equal(operations.some((operation) => operation.type === "shell.exec"), false);

  const start = operations.find((operation) => operation.type === "runtime.start");
  assert.deepEqual(start?.fields, [
    { name: "assets", required: false },
    { name: "sceneId", required: true },
  ]);

  const equal = operations.find((operation) => operation.type === "assert.equal");
  assert.deepEqual(equal?.fields, [
    { name: "expected", required: true },
    { name: "path", required: true },
  ]);

  const near = operations.find((operation) => operation.type === "assert.near");
  assert.equal(near?.fields.find((field) => field.name === "tolerance")?.required, true);
  assert.equal(near?.fields.find((field) => field.name === "expected")?.required, true);

  const input = operations.find((operation) => operation.type === "input");
  assert.equal(input?.fields.find((field) => field.name === "action")?.required, true);
  assert.equal(input?.fields.find((field) => field.name === "phase")?.required, true);
  assert.equal(input?.fields.find((field) => field.name === "value")?.required, false);

  const png = operations.find((operation) => operation.type === "assert.screenshotValidPng");
  assert.deepEqual(png?.fields, [{ name: "minBytes", required: false }]);

  assert.deepEqual(listAcceptanceOperations(), operations);
});
