import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryTransport } from "@modelcontextprotocol/server";
import { CommandError } from "@kinetra/command-bus";
import { stableId, type ProjectDocument } from "@kinetra/project-model";
import { InfrastructureError } from "@kinetra/verification";

import {
  createKinetraMcpServer,
  formatToolError,
  KinetraAgentService,
} from "../src/index.js";

const sceneId = stableId("scene", "tool-error");

function fixture(): ProjectDocument {
  return {
    schemaVersion: 1,
    projectId: stableId("project", "tool-error"),
    name: "Tool error fixture",
    scenes: [{ id: sceneId, name: "Main", entities: [] }],
  };
}

test("formatToolError keeps plain messages and structures coded errors", () => {
  assert.equal(formatToolError(new Error("Input validation error")), "Input validation error");
  assert.equal(formatToolError("offline"), "offline");

  const command = JSON.parse(
    formatToolError(new CommandError("STALE_REVISION", "Project revision is stale")),
  ) as { code: string; message: string; remediation: string };
  assert.equal(command.code, "STALE_REVISION");
  assert.equal(command.message, "Project revision is stale");
  assert.match(command.remediation, /project\.inspect/);
  assert.match(command.remediation, /expectedProjectRevision/);

  const infrastructure = JSON.parse(
    formatToolError(
      new InfrastructureError(
        "Configured KINETRA_RUNTIME_EXECUTABLE not found: missing.exe",
        "CONFIGURED_EXECUTABLE_NOT_FOUND",
      ),
    ),
  ) as { code: string; message: string; remediation?: string };
  assert.equal(infrastructure.code, "CONFIGURED_EXECUTABLE_NOT_FOUND");
  assert.match(infrastructure.message, /not found/i);
  assert.equal(infrastructure.remediation, undefined);
});

test("MCP entity.create returns command code and remediation without mutating on conflict", async () => {
  const service = new KinetraAgentService(fixture());
  const client = createClient(service);
  const entityId = stableId("entity", "tool-error-marker");

  try {
    const created = await client.callTool("entity.create", {
      sceneId,
      id: entityId,
      name: "Marker",
      expectedProjectRevision: 0,
    });
    assert.notEqual(created.isError, true);

    const conflict = await client.callTool("entity.create", {
      sceneId,
      id: entityId,
      name: "Marker again",
      expectedProjectRevision: 1,
    });
    assert.equal(conflict.isError, true);
    const body = JSON.parse(conflict.content[0]?.text ?? "") as {
      code: string;
      message: string;
      remediation: string;
    };
    assert.equal(body.code, "ENTITY_ALREADY_EXISTS");
    assert.match(body.message, /already exists/i);
    assert.match(body.remediation, /entity id/i);

    const inspected = JSON.parse(
      (await client.callTool("project.inspect", {})).content[0]?.text ?? "",
    ) as { revision: number };
    assert.equal(inspected.revision, 1);
  } finally {
    await client.close();
  }
});

test("MCP acceptance rejects an invalid project with structured validation issues", async () => {
  const client = createClient(new KinetraAgentService(fixture()));

  try {
    const result = await client.callTool("test.runAcceptance", {
      manifest: {
        schemaVersion: 1,
        suite: "invalid-project",
        seed: 1,
        target: "runtime",
        steps: [{ type: "runtime.stop" }],
      },
      project: {
        schemaVersion: 999,
        projectId: "bad",
        name: "Invalid",
        scenes: [{ id: "", name: "Broken", entities: [] }],
      },
    });

    assert.equal(result.isError, true);
    const body = JSON.parse(result.content[0]?.text ?? "") as {
      message: string;
      issues: Array<{ path: string; code: string; message: string }>;
    };
    assert.match(body.message, /Project validation failed/);
    assert.ok(body.issues.some((issue) => issue.path === "schemaVersion"));
    assert.ok(body.issues.some((issue) => issue.path.startsWith("scenes")));
  } finally {
    await client.close();
  }
});

interface CallResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
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

  return {
    async callTool(name: string, args: Record<string, unknown>): Promise<CallResult> {
      await connected;
      const id = nextId++;
      const response = await new Promise<{
        result?: CallResult;
        error?: { message: string };
      }>((resolve) => {
        pending.set(id, resolve as (value: unknown) => void);
        void clientTransport.send({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name, arguments: args },
        });
      });
      if (response.error) {
        return {
          isError: true,
          content: [{ type: "text", text: response.error.message }],
        };
      }
      return response.result ?? { content: [] };
    },
    async close() {
      await clientTransport.close();
      await serverTransport.close();
    },
  };
}
