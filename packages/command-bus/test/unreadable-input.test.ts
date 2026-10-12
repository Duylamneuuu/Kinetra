import assert from "node:assert/strict";
import test from "node:test";

import { stableId, type ProjectDocument } from "@kinetra/project-model";

import { CommandBus, CommandError, parseEngineCommand } from "../src/index.js";

const sceneId = stableId("scene", "unreadable");
const entityId = stableId("entity", "unreadable-e");

function project(): ProjectDocument {
  return {
    schemaVersion: 1,
    projectId: stableId("project", "unreadable"),
    name: "Unreadable input",
    scenes: [{ id: sceneId, name: "S", entities: [] }],
  };
}

function base(): Record<string, unknown> {
  return {
    requestId: "r",
    command: "entity.create",
    payload: { sceneId, entity: { id: entityId, name: "E", components: {} } },
  };
}

function withPayloadField(name: string, value: unknown): Record<string, unknown> {
  const command = base();
  (command.payload as Record<string, unknown>)[name] = value;
  return command;
}

function throwingGetter(): Record<string, unknown> {
  const command = base();
  Object.defineProperty(command, "boom", {
    enumerable: true,
    get() {
      throw new Error("getter exploded");
    },
  });
  return command;
}

function revokedPayload(): Record<string, unknown> {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  return { ...base(), payload: proxy };
}

const unreadable: Array<[string, () => unknown]> = [
  ["function in the envelope", () => ({ ...base(), extra: () => 1 })],
  ["function in the payload", () => withPayloadField("extra", () => 1)],
  ["symbol in the payload", () => withPayloadField("extra", Symbol("s"))],
  ["throwing getter on the envelope", throwingGetter],
  ["revoked proxy as the payload", revokedPayload],
];

for (const [label, make] of unreadable) {
  test(`parseEngineCommand reports ${label} as a structured INVALID_COMMAND`, () => {
    assert.throws(
      () => parseEngineCommand(make()),
      (error: unknown) =>
        error instanceof CommandError &&
        error.code === "INVALID_COMMAND" &&
        error.remediation.length > 0 &&
        /could not be read/.test(error.message),
      label,
    );
  });

  test(`executeUnknown leaves the project untouched for ${label}`, () => {
    const bus = new CommandBus(project());
    const before = bus.snapshot();
    const events = bus.eventLog().length;
    assert.throws(
      () => bus.executeUnknown(make()),
      (error: unknown) => error instanceof CommandError && error.code === "INVALID_COMMAND",
      label,
    );
    assert.deepEqual(bus.snapshot(), before);
    assert.equal(bus.eventLog().length, events);
  });
}

test("a throwing getter's own message is carried so the caller can find the field", () => {
  assert.throws(
    () => parseEngineCommand(throwingGetter()),
    (error: unknown) => error instanceof CommandError && /getter exploded/.test(error.message),
  );
});

test("shape errors keep their specific message and are not re-wrapped", () => {
  assert.throws(
    () => parseEngineCommand({ requestId: "", command: "x", payload: {} }),
    (error: unknown) =>
      error instanceof CommandError &&
      error.message === "Command requestId must be a non-empty string",
  );
  assert.throws(
    () => parseEngineCommand({ requestId: "r", command: "nope", payload: {} }),
    (error: unknown) => error instanceof CommandError && error.message === 'Unsupported command "nope"',
  );
});

test("a readable command is returned as a detached deep copy", () => {
  const input = base();
  const parsed = parseEngineCommand(input);
  assert.deepEqual(parsed, input);
  assert.notEqual(parsed, input);
  assert.notEqual(parsed.payload, input.payload);
});

test("random garbage never escapes as anything but a CommandError", () => {
  let seed = 0x9e3779b9;
  const next = (): number => {
    seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x297a2d39) >>> 0;
    return seed / 0x100000000;
  };
  const atoms: unknown[] = [
    null, undefined, 0, -1, 1.5, NaN, Infinity, "", "x", true, 10n, Symbol("g"),
    () => 1, new Date(0), new Map(), [], {}, [1, [2]], { a: { b: {} } },
  ];
  const pick = (): unknown => atoms[Math.floor(next() * atoms.length)];
  const names = ["requestId", "command", "payload", "dryRun", "expectedProjectRevision", "transactionId", "sceneId", "entity", "entityId"];
  for (let i = 0; i < 500; i += 1) {
    const candidate: Record<string, unknown> = {};
    for (const name of names) if (next() < 0.6) candidate[name] = pick();
    if (next() < 0.5) candidate.payload = { sceneId: pick(), entity: { id: pick(), name: pick(), components: pick() }, entityId: pick() };
    if (next() < 0.5) candidate.command = ["scene.create", "entity.create", "component.patch", "entity.reparent", "entity.delete"][Math.floor(next() * 5)];
    try {
      parseEngineCommand(next() < 0.1 ? pick() : candidate);
    } catch (error) {
      assert.ok(error instanceof CommandError, `iteration ${i}: ${String(error)}`);
      assert.equal(error.code, "INVALID_COMMAND");
    }
  }
});
