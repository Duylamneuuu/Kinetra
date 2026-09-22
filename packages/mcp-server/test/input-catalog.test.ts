import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { InMemoryTransport } from "@modelcontextprotocol/server";
import { DEFAULT_PLAYER_INPUT_MAP } from "@kinetra/input";
import { stableId, type ProjectDocument } from "@kinetra/project-model";

import { createKinetraMcpServer, KinetraAgentService } from "../src/index.js";

const sceneId = stableId("scene", "input-catalog");

function fixture(): ProjectDocument {
  return {
    schemaVersion: 1,
    projectId: stableId("project", "input-catalog"),
    name: "Input catalog fixture",
    scenes: [{ id: sceneId, name: "Main", entities: [] }],
  };
}

test("input.query returns the engine-default semantic actions", async () => {
  const before = structuredClone(DEFAULT_PLAYER_INPUT_MAP);
  const client = createClient(new KinetraAgentService(fixture()));

  try {
    const result = await client.callTool("input.query", {});
    assert.notEqual(result.isError, true);
    const body = JSON.parse(result.content[0]?.text ?? "") as {
      schemaVersion: number;
      source: string;
      actions: Array<{
        id: string;
        type: string;
        bindings: Array<{ kind: string }>;
      }>;
    };

    assert.equal(body.schemaVersion, 1);
    assert.equal(body.source, "engine-default");
    const ids = body.actions.map((action) => action.id);
    assert.deepEqual(ids, [...ids].sort((left, right) => left.localeCompare(right)));
    for (const required of [
      "player.moveForward",
      "player.moveBackward",
      "player.moveLeft",
      "player.moveRight",
      "player.jump",
      "player.attack",
      "game.pause",
      "ui.confirm",
      "ui.back",
    ]) {
      assert.ok(ids.includes(required), required);
    }

    const attack = body.actions.find((action) => action.id === "player.attack");
    assert.equal(attack?.type, "button");
    assert.ok(attack?.bindings.some((binding) => binding.kind === "key"));
    assert.ok(body.actions.every((action) => !action.id.startsWith("Key")));
    assert.deepEqual(DEFAULT_PLAYER_INPUT_MAP, before);
  } finally {
    await client.close();
  }
});

test("tool list tells agents where semantic actions are consumed", async () => {
  const client = createClient(new KinetraAgentService(fixture()));

  try {
    const listed = await client.listTools();
    const byName = new Map(listed.map((tool) => [tool.name, tool.description]));
    const readme = await readFile(readmePath(), "utf8");

    for (const tool of listed) {
      assert.ok(tool.description.trim().length > 20, tool.name);
      assert.match(readme, new RegExp(`\\b${tool.name.replace(".", "\\.")}\\b`));
    }

    const inject = byName.get("runtime.injectInput") ?? "";
    assert.match(inject, /input\.query/);
    assert.doesNotMatch(inject, /later phases/i);
    assert.match(inject, /does not move entities/);

    const start = byName.get("runtime.start") ?? "";
    assert.match(start, /does not run gameplay scripts/);

    const acceptance = byName.get("test.runAcceptance") ?? "";
    assert.match(acceptance, /input\.query/);
    assert.match(acceptance, /packaged/);
  } finally {
    await client.close();
  }
});

function readmePath(): string {
  let current = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 5; depth += 1) {
    if (existsSync(join(current, "package.json"))) {
      return join(current, "README.md");
    }
    current = dirname(current);
  }
  throw new Error("Could not find the mcp-server package root");
}

interface CallResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

interface ListedTool {
  name: string;
  description: string;
}

function createClient(service: KinetraAgentService) {
  const server = createKinetraMcpServer(service);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  let nextId = 1;
  const pending = new Map<number, (value: unknown) => void>();

  clientTransport.onmessage = (message: unknown) => {
    const response = message as { id?: number };
    if (response.id !== undefined && pending.has(response.id)) {
      const resolve = pending.get(response.id);
      pending.delete(response.id);
      resolve?.(message);
    }
  };

  const connected = (async () => {
    await server.connect(serverTransport);
    await clientTransport.start();
  })();

  async function request(method: string, params?: Record<string, unknown>) {
    await connected;
    const id = nextId++;
    return new Promise<{
      result?: unknown;
      error?: { message: string };
    }>((resolve) => {
      pending.set(id, resolve as (value: unknown) => void);
      void clientTransport.send({
        jsonrpc: "2.0",
        id,
        method,
        ...(params !== undefined ? { params } : {}),
      });
    });
  }

  return {
    async callTool(name: string, args: Record<string, unknown>): Promise<CallResult> {
      const response = await request("tools/call", { name, arguments: args });
      if (response.error) {
        return {
          isError: true,
          content: [{ type: "text", text: response.error.message }],
        };
      }
      return (response.result as CallResult | undefined) ?? { content: [] };
    },
    async listTools(): Promise<ListedTool[]> {
      const response = await request("tools/list");
      if (response.error) {
        throw new Error(response.error.message);
      }
      const result = response.result as { tools?: ListedTool[] } | undefined;
      return result?.tools ?? [];
    },
    async close() {
      await clientTransport.close();
      await serverTransport.close();
    },
  };
}
