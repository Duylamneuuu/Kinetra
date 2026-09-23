import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CommandError, listEngineCommands, parseEngineCommand } from "../src/index.js";

const commandNames = [
  "component.patch",
  "entity.create",
  "entity.delete",
  "entity.reparent",
  "scene.create",
];

test("listEngineCommands describes the authoring envelope and payload fields", () => {
  const catalog = listEngineCommands();
  assert.equal(catalog.schemaVersion, 1);
  assert.deepEqual(
    catalog.envelope.map((field) => [field.name, field.required]),
    [
      ["requestId", true],
      ["expectedProjectRevision", false],
      ["transactionId", false],
      ["dryRun", false],
    ],
  );
  assert.deepEqual(
    catalog.commands.map((command) => command.name),
    commandNames,
  );

  const patch = catalog.commands.find((command) => command.name === "component.patch");
  assert.deepEqual(
    patch?.payload.map((field) => [field.name, field.required]),
    [
      ["entityId", true],
      ["component", true],
      ["patch", true],
    ],
  );

  const deleted = catalog.commands.find((command) => command.name === "entity.delete");
  assert.equal(deleted?.payload.find((field) => field.name === "cascade")?.required, false);

  catalog.commands[0]!.name = "mutated";
  catalog.envelope[0]!.required = false;
  assert.deepEqual(
    listEngineCommands().commands.map((command) => command.name),
    commandNames,
  );
  assert.equal(listEngineCommands().envelope[0]?.required, true);
});

test("every catalog command parses and an unknown name lists the alternatives", () => {
  const payloads: Record<string, Record<string, unknown>> = {
    "component.patch": {
      entityId: "entity_box",
      component: "Transform",
      patch: { position: [1, 0, 0] },
    },
    "entity.create": {
      sceneId: "scene_main",
      entity: { id: "entity_box", name: "Box", components: {} },
    },
    "entity.delete": { entityId: "entity_box" },
    "entity.reparent": { entityId: "entity_box" },
    "scene.create": {
      scene: { id: "scene_main", name: "Main", entities: [] },
    },
  };

  for (const name of commandNames) {
    const command = parseEngineCommand({
      requestId: `req-${name}`,
      command: name,
      payload: payloads[name],
    });
    assert.equal(command.command, name);
  }

  assert.throws(
    () =>
      parseEngineCommand({
        requestId: "req-unknown",
        command: "entity.move",
        payload: {},
      }),
    (error: unknown) =>
      error instanceof CommandError &&
      error.code === "INVALID_COMMAND" &&
      error.message === 'Unsupported command "entity.move"' &&
      error.remediation === `Use one of: ${commandNames.join(", ")}.`,
  );
});

function sourceFile(name: string): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let hop = 0; hop < 6; hop += 1) {
    const candidate = join(dir, "src", name);
    if (existsSync(candidate)) return readFileSync(candidate, "utf8");
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`command-bus src/${name} was not found`);
}

function commandCases(source: string): string[] {
  return [...source.matchAll(/case "([^"]+)":/g)].map((match) => match[1] ?? "").sort();
}

test("catalog names are the command cases in the parser and the bus", () => {
  const expected = [...commandNames].sort();
  assert.deepEqual(commandCases(sourceFile("validation.ts")), expected);
  assert.deepEqual(commandCases(sourceFile("bus.ts")), expected);
});
