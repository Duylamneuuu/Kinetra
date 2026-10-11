import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryTransport } from "@modelcontextprotocol/server";
import { stableId, type ProjectDocument } from "@kinetra/project-model";

import { createKinetraMcpServer, KinetraAgentService } from "../src/index.js";

// Every MCP mutation/query tool maps its schema fields onto a service call by hand. These tests
// drive the registered tools through a real MCP transport with *every optional field set*, so a
// field that is silently dropped on the way to the service (dryRun, expectedProjectRevision,
// cascade, parentId, query filters) fails here instead of in an agent session.

const sceneId = stableId("scene", "forwarding");
const otherSceneId = stableId("scene", "forwarding-other");
const parentId = stableId("entity", "forwarding-parent");
const childId = stableId("entity", "forwarding-child");
const looseId = stableId("entity", "forwarding-loose");
const otherSceneEntityId = stableId("entity", "forwarding-elsewhere");

function fixture(): ProjectDocument {
  return {
    schemaVersion: 1,
    projectId: stableId("project", "forwarding"),
    name: "Tool forwarding fixture",
    scenes: [{ id: sceneId, name: "Main", entities: [] }],
  };
}

async function seededService(): Promise<KinetraAgentService> {
  const service = new KinetraAgentService(fixture());
  await service.createEntity({
    sceneId,
    id: parentId,
    name: "Parent Box",
    components: { Primitive: { kind: "box" }, Transform: { position: [0, 1, 0] } },
  });
  await service.createEntity({
    sceneId,
    id: childId,
    name: "Alpha CHILD",
    parentId,
    components: { Primitive: { kind: "box" } },
  });
  await service.createEntity({
    sceneId,
    id: looseId,
    name: "Loose",
    components: { Transform: { position: [1, 2, 3] } },
  });
  await service.createScene({ id: otherSceneId, name: "Other" });
  await service.createEntity({
    sceneId: otherSceneId,
    id: otherSceneEntityId,
    name: "Elsewhere",
    components: { Transform: { position: [9, 9, 9] } },
  });
  return service;
}

interface QueryBody {
  items: Array<{ sceneId: string; entity: { id: string; parentId?: string; components: Record<string, unknown> } }>;
  total: number;
  offset: number;
  limit: number;
  nextOffset?: number;
}

async function json<T>(call: Promise<CallResult>): Promise<T> {
  const result = await call;
  assert.notEqual(result.isError, true, result.content[0]?.text);
  return JSON.parse(result.content[0]?.text ?? "") as T;
}

async function errorCode(call: Promise<CallResult>): Promise<string> {
  const result = await call;
  assert.equal(result.isError, true, "expected the tool call to fail");
  return (JSON.parse(result.content[0]?.text ?? "") as { code: string }).code;
}

async function revisionOf(client: ReturnType<typeof createClient>): Promise<number> {
  return (await json<{ revision: number }>(client.callTool("project.inspect", {}))).revision;
}

async function queryIds(
  client: ReturnType<typeof createClient>,
  args: Record<string, unknown>,
): Promise<string[]> {
  const body = await json<QueryBody>(client.callTool("entity.query", args));
  return body.items.map((item) => item.entity.id);
}

test("entity.query forwards every filter, selection and paging field to the command bus", async () => {
  const client = createClient(await seededService());
  try {
    assert.deepEqual(await queryIds(client, { component: "Primitive" }), [parentId, childId]);
    assert.deepEqual(await queryIds(client, { component: "Transform", sceneId }), [parentId, looseId]);
    assert.deepEqual(await queryIds(client, { sceneId: otherSceneId }), [otherSceneEntityId]);
    // Case-insensitive substring: "Alpha CHILD" matches "child".
    assert.deepEqual(await queryIds(client, { nameContains: "child" }), [childId]);
    assert.deepEqual(await queryIds(client, { ids: [looseId, otherSceneEntityId] }), [looseId, otherSceneEntityId]);
    assert.deepEqual(await queryIds(client, { ids: [] }), []);

    const selected = await json<QueryBody>(
      client.callTool("entity.query", { ids: [parentId], selectComponents: ["Transform"] }),
    );
    assert.deepEqual(Object.keys(selected.items[0]?.entity.components ?? {}), ["Transform"]);

    const firstPage = await json<QueryBody>(
      client.callTool("entity.query", { component: "Primitive", offset: 0, limit: 1 }),
    );
    assert.deepEqual(firstPage.items.map((item) => item.entity.id), [parentId]);
    assert.equal(firstPage.total, 2);
    assert.equal(firstPage.limit, 1);
    assert.equal(firstPage.nextOffset, 1);

    const lastPage = await json<QueryBody>(
      client.callTool("entity.query", { component: "Primitive", offset: 1, limit: 1 }),
    );
    assert.deepEqual(lastPage.items.map((item) => item.entity.id), [childId]);
    assert.equal(lastPage.offset, 1);
    assert.equal(lastPage.nextOffset, undefined);
  } finally {
    await client.close();
  }
});

test("scene.create and entity.create honour dryRun and expectedProjectRevision", async () => {
  const client = createClient(await seededService());
  try {
    const before = await revisionOf(client);

    const dryScene = await json<{ revision: number; proposedRevision: number }>(
      client.callTool("scene.create", { name: "Dry", id: stableId("scene", "dry"), dryRun: true, expectedProjectRevision: before }),
    );
    assert.equal(dryScene.revision, before);
    assert.equal(dryScene.proposedRevision, before + 1);
    assert.equal(await revisionOf(client), before, "a dry run must not advance the revision");
    const scenes = await json<Array<{ id: string }>>(client.callTool("scene.query", {}));
    assert.ok(!scenes.some((scene) => scene.id === stableId("scene", "dry")));

    assert.equal(
      await errorCode(client.callTool("scene.create", { name: "Stale", expectedProjectRevision: before + 50 })),
      "STALE_REVISION",
    );

    const dryEntity = await json<{ proposedRevision: number }>(
      client.callTool("entity.create", {
        sceneId,
        name: "Ghost",
        id: stableId("entity", "ghost"),
        parentId,
        dryRun: true,
      }),
    );
    assert.equal(dryEntity.proposedRevision, before + 1);
    assert.deepEqual(await queryIds(client, { nameContains: "ghost" }), []);

    assert.equal(
      await errorCode(
        client.callTool("entity.create", { sceneId, name: "Stale", expectedProjectRevision: before + 50 }),
      ),
      "STALE_REVISION",
    );

    // A real create with a parentId keeps that parent.
    await json(
      client.callTool("entity.create", {
        sceneId,
        name: "Real Child",
        id: stableId("entity", "real-child"),
        parentId,
        expectedProjectRevision: before,
      }),
    );
    const created = await json<QueryBody>(
      client.callTool("entity.query", { ids: [stableId("entity", "real-child")] }),
    );
    assert.equal(created.items[0]?.entity.parentId, parentId);
    assert.equal(await revisionOf(client), before + 1);
  } finally {
    await client.close();
  }
});

test("entity.patch, entity.reparent and entity.delete honour dryRun, cascade and expectedProjectRevision", async () => {
  const client = createClient(await seededService());
  try {
    const before = await revisionOf(client);

    // --- entity.patch
    assert.equal(
      await errorCode(
        client.callTool("entity.patch", {
          entityId: looseId,
          component: "Transform",
          patch: { position: [5, 5, 5] },
          expectedProjectRevision: before + 50,
        }),
      ),
      "STALE_REVISION",
    );
    await json(
      client.callTool("entity.patch", {
        entityId: looseId,
        component: "Transform",
        patch: { position: [5, 5, 5] },
        dryRun: true,
        expectedProjectRevision: before,
      }),
    );
    let loose = await json<QueryBody>(client.callTool("entity.query", { ids: [looseId] }));
    assert.deepEqual(loose.items[0]?.entity.components.Transform, { position: [1, 2, 3] });
    assert.equal(await revisionOf(client), before);

    // --- entity.reparent
    assert.equal(
      await errorCode(
        client.callTool("entity.reparent", { entityId: looseId, parentId, expectedProjectRevision: before + 50 }),
      ),
      "STALE_REVISION",
    );
    await json(client.callTool("entity.reparent", { entityId: looseId, parentId, dryRun: true }));
    loose = await json<QueryBody>(client.callTool("entity.query", { ids: [looseId] }));
    assert.equal(loose.items[0]?.entity.parentId, undefined, "a dry-run reparent must not move the entity");

    await json(client.callTool("entity.reparent", { entityId: looseId, parentId, expectedProjectRevision: before }));
    loose = await json<QueryBody>(client.callTool("entity.query", { ids: [looseId] }));
    assert.equal(loose.items[0]?.entity.parentId, parentId);

    // Omitting parentId detaches the entity again.
    await json(client.callTool("entity.reparent", { entityId: looseId }));
    loose = await json<QueryBody>(client.callTool("entity.query", { ids: [looseId] }));
    assert.equal(loose.items[0]?.entity.parentId, undefined);

    const afterReparent = await revisionOf(client);

    // --- entity.delete
    assert.equal(
      await errorCode(client.callTool("entity.delete", { entityId: parentId })),
      "CHILDREN_EXIST",
      "deleting a parent without cascade must be refused",
    );
    assert.equal(
      await errorCode(client.callTool("entity.delete", { entityId: parentId, cascade: false })),
      "CHILDREN_EXIST",
    );
    assert.equal(
      await errorCode(
        client.callTool("entity.delete", { entityId: parentId, cascade: true, expectedProjectRevision: afterReparent + 50 }),
      ),
      "STALE_REVISION",
    );
    await json(client.callTool("entity.delete", { entityId: parentId, cascade: true, dryRun: true }));
    assert.deepEqual(await queryIds(client, { ids: [parentId, childId] }), [parentId, childId]);
    assert.equal(await revisionOf(client), afterReparent);

    await json(
      client.callTool("entity.delete", { entityId: parentId, cascade: true, expectedProjectRevision: afterReparent }),
    );
    assert.deepEqual(await queryIds(client, { ids: [parentId, childId, looseId] }), [looseId]);
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
