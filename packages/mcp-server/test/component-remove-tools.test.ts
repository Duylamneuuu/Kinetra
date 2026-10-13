import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryTransport } from "@modelcontextprotocol/server";
import { stableId, type ProjectDocument } from "@kinetra/project-model";

import { createKinetraMcpServer, KinetraAgentService } from "../src/index.js";

// entity.removeComponent / entity.unsetFields expose the command-bus commands component.remove and
// component.unsetFields (#455) to agents. They must go through the bus: revision preconditions,
// dry-run without a revision change, structured errors with remediation, and undo.

const sceneId = stableId("scene", "remove-tools");
const entityId = stableId("entity", "remove-tools-box");

function fixture(): ProjectDocument {
  return {
    schemaVersion: 1,
    projectId: stableId("project", "remove-tools"),
    name: "Remove tools fixture",
    scenes: [{ id: sceneId, name: "Main", entities: [] }],
  };
}

async function seededService(): Promise<KinetraAgentService> {
  const service = new KinetraAgentService(fixture());
  await service.createEntity({
    sceneId,
    id: entityId,
    name: "Box",
    components: {
      Primitive: { kind: "box", color: "#ff0000", roughness: 0.5 },
      Transform: { position: [1, 2, 3] },
      Tag: "player",
    },
  });
  return service;
}

interface CallResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

interface MutationBody {
  revision: number;
  proposedRevision: number;
  undoToken?: string;
}

interface ErrorBody {
  code: string;
  message: string;
  remediation?: string;
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
        return { isError: true, content: [{ type: "text", text: response.error.message }] };
      }
      return response.result ?? { content: [] };
    },
    async close() {
      await clientTransport.close();
      await serverTransport.close();
    },
  };
}

type Client = ReturnType<typeof createClient>;

async function ok<T>(call: Promise<CallResult>): Promise<T> {
  const result = await call;
  assert.notEqual(result.isError, true, result.content[0]?.text);
  return JSON.parse(result.content[0]?.text ?? "") as T;
}

async function failure(call: Promise<CallResult>): Promise<ErrorBody> {
  const result = await call;
  assert.equal(result.isError, true, "expected the tool call to fail");
  return JSON.parse(result.content[0]?.text ?? "") as ErrorBody;
}

async function components(client: Client): Promise<Record<string, unknown>> {
  const body = await ok<{ items: Array<{ entity: { components: Record<string, unknown> } }> }>(
    client.callTool("entity.query", { ids: [entityId] }),
  );
  return body.items[0]?.entity.components ?? {};
}

async function revisionOf(client: Client): Promise<number> {
  return (await ok<{ revision: number }>(client.callTool("project.inspect", {}))).revision;
}

test("entity.removeComponent removes a whole component, honours dryRun and revision, and undoes", async () => {
  const client = createClient(await seededService());
  try {
    const before = await revisionOf(client);

    const stale = await failure(
      client.callTool("entity.removeComponent", {
        entityId,
        component: "Primitive",
        expectedProjectRevision: before + 50,
      }),
    );
    assert.equal(stale.code, "STALE_REVISION");

    const dry = await ok<MutationBody>(
      client.callTool("entity.removeComponent", {
        entityId,
        component: "Primitive",
        dryRun: true,
        expectedProjectRevision: before,
      }),
    );
    assert.equal(dry.proposedRevision, before + 1);
    assert.equal(await revisionOf(client), before, "a dry run must not advance the revision");
    assert.ok("Primitive" in (await components(client)));

    const removed = await ok<MutationBody>(
      client.callTool("entity.removeComponent", {
        entityId,
        component: "Primitive",
        expectedProjectRevision: before,
      }),
    );
    assert.equal(removed.revision, before + 1);
    assert.ok(removed.undoToken, "a committed removal returns an undo token");
    const afterRemove = await components(client);
    assert.ok(!("Primitive" in afterRemove));
    assert.deepEqual(afterRemove.Transform, { position: [1, 2, 3] }, "other components stay untouched");

    // Removing it again is a structured COMPONENT_NOT_FOUND and changes nothing.
    const again = await failure(
      client.callTool("entity.removeComponent", { entityId, component: "Primitive" }),
    );
    assert.equal(again.code, "COMPONENT_NOT_FOUND");
    assert.ok(again.remediation && again.remediation.length > 0);
    assert.equal(await revisionOf(client), before + 1);

    // Undo through project.undo brings the component back with its exact fields.
    const undone = await ok<MutationBody>(
      client.callTool("project.undo", { undoToken: removed.undoToken }),
    );
    assert.equal(undone.revision, before + 2);
    assert.deepEqual((await components(client)).Primitive, {
      kind: "box",
      color: "#ff0000",
      roughness: 0.5,
    });
  } finally {
    await client.close();
  }
});

test("entity.removeComponent reports a missing entity and rejects malformed input", async () => {
  const client = createClient(await seededService());
  try {
    const before = await revisionOf(client);

    const missing = await failure(
      client.callTool("entity.removeComponent", {
        entityId: stableId("entity", "nope"),
        component: "Primitive",
      }),
    );
    assert.equal(missing.code, "ENTITY_NOT_FOUND");
    assert.ok(missing.remediation && missing.remediation.length > 0);

    // Empty strings never reach the bus: the tool schema refuses them.
    const emptyComponent = await client.callTool("entity.removeComponent", { entityId, component: "" });
    assert.equal(emptyComponent.isError, true);
    const noEntity = await client.callTool("entity.removeComponent", { component: "Primitive" });
    assert.equal(noEntity.isError, true);

    assert.equal(await revisionOf(client), before);
  } finally {
    await client.close();
  }
});

test("entity.unsetFields deletes fields, honours dryRun and revision, and undoes", async () => {
  const client = createClient(await seededService());
  try {
    const before = await revisionOf(client);

    const stale = await failure(
      client.callTool("entity.unsetFields", {
        entityId,
        component: "Primitive",
        fields: ["color"],
        expectedProjectRevision: before + 50,
      }),
    );
    assert.equal(stale.code, "STALE_REVISION");

    const dry = await ok<MutationBody>(
      client.callTool("entity.unsetFields", {
        entityId,
        component: "Primitive",
        fields: ["color", "roughness"],
        dryRun: true,
      }),
    );
    assert.equal(dry.proposedRevision, before + 1);
    assert.equal(await revisionOf(client), before);
    assert.deepEqual((await components(client)).Primitive, {
      kind: "box",
      color: "#ff0000",
      roughness: 0.5,
    });

    const unset = await ok<MutationBody>(
      client.callTool("entity.unsetFields", {
        entityId,
        component: "Primitive",
        fields: ["color", "roughness"],
        expectedProjectRevision: before,
      }),
    );
    assert.equal(unset.revision, before + 1);
    assert.deepEqual((await components(client)).Primitive, { kind: "box" });

    const undone = await ok<MutationBody>(
      client.callTool("project.undo", { undoToken: unset.undoToken }),
    );
    assert.equal(undone.revision, before + 2);
    assert.deepEqual((await components(client)).Primitive, {
      kind: "box",
      color: "#ff0000",
      roughness: 0.5,
    });
  } finally {
    await client.close();
  }
});

test("entity.unsetFields returns structured errors and never half-applies", async () => {
  const client = createClient(await seededService());
  try {
    const before = await revisionOf(client);

    const missingField = await failure(
      client.callTool("entity.unsetFields", {
        entityId,
        component: "Primitive",
        fields: ["color", "doesNotExist"],
      }),
    );
    assert.equal(missingField.code, "FIELD_NOT_FOUND");
    assert.match(missingField.message, /doesNotExist/);
    assert.ok(missingField.remediation && missingField.remediation.length > 0);

    const missingComponent = await failure(
      client.callTool("entity.unsetFields", { entityId, component: "Light", fields: ["kind"] }),
    );
    assert.equal(missingComponent.code, "COMPONENT_NOT_FOUND");

    const missingEntity = await failure(
      client.callTool("entity.unsetFields", {
        entityId: stableId("entity", "nope"),
        component: "Primitive",
        fields: ["kind"],
      }),
    );
    assert.equal(missingEntity.code, "ENTITY_NOT_FOUND");

    const notObject = await failure(
      client.callTool("entity.unsetFields", { entityId, component: "Tag", fields: ["x"] }),
    );
    assert.equal(notObject.code, "COMPONENT_NOT_OBJECT");
    assert.match(notObject.message, /entity\.removeComponent|component\.remove/);

    // Empty field list and empty field name are refused by the tool schema.
    const emptyList = await client.callTool("entity.unsetFields", { entityId, component: "Primitive", fields: [] });
    assert.equal(emptyList.isError, true);
    const emptyName = await client.callTool("entity.unsetFields", { entityId, component: "Primitive", fields: [""] });
    assert.equal(emptyName.isError, true);

    // Nothing above changed the project: the first call listed a valid field next to a bad one.
    assert.equal(await revisionOf(client), before);
    assert.deepEqual((await components(client)).Primitive, {
      kind: "box",
      color: "#ff0000",
      roughness: 0.5,
    });
  } finally {
    await client.close();
  }
});
