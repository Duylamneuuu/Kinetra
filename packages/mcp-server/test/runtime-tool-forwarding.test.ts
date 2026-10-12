import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryTransport } from "@modelcontextprotocol/server";
import { stableId, type ProjectDocument } from "@kinetra/project-model";

import {
  createKinetraMcpServer,
  KinetraAgentService,
  type RuntimeFrameCapture,
  type RuntimeHost,
  type RuntimeInputEvent,
  type RuntimeLogEntry,
  type RuntimeQuery,
  type RuntimeQueryResult,
} from "../src/index.js";

// The runtime.* and test.runAcceptance MCP tools map their schema fields onto RuntimeHost /
// service calls by hand. These tests drive them through a real MCP transport against a recording
// host (no Electron), so a dropped field, a lost default, a wrongly shaped image response or an
// unstructured error fails here instead of in an agent session.

const sceneId = stableId("scene", "runtime-tools");

function fixture(): ProjectDocument {
  return {
    schemaVersion: 1,
    projectId: stableId("project", "runtime-tools"),
    name: "Runtime tool forwarding",
    scenes: [{ id: sceneId, name: "Main", entities: [] }],
  };
}

interface RecordingHost extends RuntimeHost {
  calls: Array<{ method: string; args: unknown[] }>;
  startError?: Error;
  captureResult: RuntimeFrameCapture | Error;
}

function recordingHost(): RecordingHost {
  const host: RecordingHost = {
    calls: [],
    captureResult: { available: false, reason: "no frame" },
    async start(project, scene, revision) {
      host.calls.push({ method: "start", args: [project.projectId, scene, revision] });
      if (host.startError) throw host.startError;
    },
    async stop() {
      host.calls.push({ method: "stop", args: [] });
    },
    async query(query?: RuntimeQuery): Promise<RuntimeQueryResult> {
      host.calls.push({ method: "query", args: [query] });
      return { running: true, sceneId, projectRevision: 0, entities: [] };
    },
    async injectInput(event: RuntimeInputEvent) {
      host.calls.push({ method: "injectInput", args: [event] });
    },
    async captureFrame() {
      host.calls.push({ method: "captureFrame", args: [] });
      if (host.captureResult instanceof Error) throw host.captureResult;
      return host.captureResult;
    },
    async readLogs(since?: number): Promise<RuntimeLogEntry[]> {
      host.calls.push({ method: "readLogs", args: [since] });
      return [{ sequence: (since ?? 0) + 1, level: "info", message: "recorded" }];
    },
  };
  return host;
}

interface CallResult {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
}

function textOf(result: CallResult): string {
  const text = result.content.find((item) => item.type === "text")?.text;
  assert.ok(text !== undefined, "expected a text content item");
  return text;
}

function createClient(host: RecordingHost) {
  const service = new KinetraAgentService(fixture(), { runtime: host });
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
      const response = await new Promise<{ result?: CallResult; error?: { message: string } }>((resolve) => {
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

test("runtime.start hands the current revision and scene to the host, then returns the live query", async () => {
  const host = recordingHost();
  const client = createClient(host);
  try {
    const result = await client.callTool("runtime.start", { sceneId });
    assert.notEqual(result.isError, true, textOf(result));
    assert.deepEqual(host.calls.map((call) => call.method), ["start", "query"]);
    assert.deepEqual(host.calls[0]?.args, [stableId("project", "runtime-tools"), sceneId, 0]);
    assert.deepEqual(host.calls[1]?.args, [{}], "the follow-up query must not filter entities");
    assert.equal((JSON.parse(textOf(result)) as RuntimeQueryResult).running, true);

    const empty = await client.callTool("runtime.start", { sceneId: "" });
    assert.equal(empty.isError, true, "an empty sceneId is refused by the schema");
    assert.equal(host.calls.length, 2, "a refused call must not reach the host");
  } finally {
    await client.close();
  }
});

test("runtime.start reports a host failure as a tool error and does not query", async () => {
  const host = recordingHost();
  host.startError = Object.assign(new Error("scene is missing"), { code: "SCENE_NOT_FOUND" });
  const client = createClient(host);
  try {
    const result = await client.callTool("runtime.start", { sceneId });
    assert.equal(result.isError, true);
    assert.equal((JSON.parse(textOf(result)) as { code: string }).code, "SCENE_NOT_FOUND");
    assert.deepEqual(host.calls.map((call) => call.method), ["start"]);
  } finally {
    await client.close();
  }
});

test("runtime.stop and runtime.query forward to the host; entityIds is only sent when given", async () => {
  const host = recordingHost();
  const client = createClient(host);
  try {
    const stopped = await client.callTool("runtime.stop", {});
    assert.deepEqual(JSON.parse(textOf(stopped)), { stopped: true });

    await client.callTool("runtime.query", {});
    await client.callTool("runtime.query", { entityIds: [] });
    await client.callTool("runtime.query", { entityIds: ["a", "b"] });
    assert.deepEqual(
      host.calls.map((call) => [call.method, call.args]),
      [
        ["stop", []],
        ["query", [{}]],
        ["query", [{ entityIds: [] }]],
        ["query", [{ entityIds: ["a", "b"] }]],
      ],
    );

    const tooMany = await client.callTool("runtime.query", {
      entityIds: Array.from({ length: 501 }, (_, index) => `e${index}`),
    });
    assert.equal(tooMany.isError, true, "more than 500 entity ids is refused");
    assert.equal(host.calls.length, 4);
  } finally {
    await client.close();
  }
});

test("runtime.injectInput defaults the phase to press and forwards only the fields it was given", async () => {
  const host = recordingHost();
  const client = createClient(host);
  try {
    const bare = await client.callTool("runtime.injectInput", { action: "jump" });
    assert.deepEqual(JSON.parse(textOf(bare)), { accepted: true });
    await client.callTool("runtime.injectInput", { action: "move", phase: "hold", value: [0.5, -1], durationMs: 250 });
    await client.callTool("runtime.injectInput", { action: "aim", phase: "release", value: 0, durationMs: 0 });

    assert.deepEqual(
      host.calls.map((call) => call.args[0]),
      [
        { action: "jump", phase: "press" },
        { action: "move", phase: "hold", value: [0.5, -1], durationMs: 250 },
        { action: "aim", phase: "release", value: 0, durationMs: 0 },
      ],
      "value 0 and durationMs 0 are real values, not absent ones",
    );

    for (const bad of [
      { action: "" },
      { action: "jump", phase: "tap" },
      { action: "jump", durationMs: -1 },
      { action: "jump", value: [1, 2, 3] },
    ]) {
      const result = await client.callTool("runtime.injectInput", bad);
      assert.equal(result.isError, true, `${JSON.stringify(bad)} must be refused`);
    }
    assert.equal(host.calls.length, 3, "refused events never reach the host");
  } finally {
    await client.close();
  }
});

test("runtime.readLogs defaults the cursor to 0 and forwards an explicit one", async () => {
  const host = recordingHost();
  const client = createClient(host);
  try {
    const first = await client.callTool("runtime.readLogs", {});
    assert.deepEqual(JSON.parse(textOf(first)), [{ sequence: 1, level: "info", message: "recorded" }]);
    await client.callTool("runtime.readLogs", { sinceSequence: 41 });
    assert.deepEqual(host.calls.map((call) => call.args[0]), [0, 41]);

    for (const bad of [{ sinceSequence: -1 }, { sinceSequence: 1.5 }]) {
      assert.equal((await client.callTool("runtime.readLogs", bad)).isError, true);
    }
    assert.equal(host.calls.length, 2);
  } finally {
    await client.close();
  }
});

test("runtime.captureFrame returns an image item plus size metadata when the host has a frame", async () => {
  const host = recordingHost();
  // 8 base64 chars = 6 bytes.
  host.captureResult = { available: true, mimeType: "image/png", base64: "AAECAwQF" };
  const client = createClient(host);
  try {
    const result = await client.callTool("runtime.captureFrame", {});
    assert.notEqual(result.isError, true);
    assert.deepEqual(result.content.map((item) => item.type), ["image", "text"]);
    assert.equal(result.content[0]?.data, "AAECAwQF");
    assert.equal(result.content[0]?.mimeType, "image/png");
    assert.deepEqual(JSON.parse(textOf(result)), { available: true, mimeType: "image/png", bytesApprox: 6 });
  } finally {
    await client.close();
  }
});

test("runtime.captureFrame falls back to plain JSON when the frame is unavailable or incomplete", async () => {
  const host = recordingHost();
  const client = createClient(host);
  try {
    const unavailable = await client.callTool("runtime.captureFrame", {});
    assert.deepEqual(unavailable.content.map((item) => item.type), ["text"]);
    assert.deepEqual(JSON.parse(textOf(unavailable)), { available: false, reason: "no frame" });

    // A host that claims a frame but omits the bytes or the mime type must not produce a
    // half-built image item.
    host.captureResult = { available: true, mimeType: "image/png" };
    const noBytes = await client.callTool("runtime.captureFrame", {});
    assert.deepEqual(noBytes.content.map((item) => item.type), ["text"]);
    assert.equal((JSON.parse(textOf(noBytes)) as RuntimeFrameCapture).available, true);

    host.captureResult = { available: true, base64: "AAAA" };
    const noMime = await client.callTool("runtime.captureFrame", {});
    assert.deepEqual(noMime.content.map((item) => item.type), ["text"]);
  } finally {
    await client.close();
  }
});

test("runtime.captureFrame turns a host exception into a structured tool error", async () => {
  const host = recordingHost();
  host.captureResult = Object.assign(new Error("renderer crashed"), {
    code: "RUNTIME_CRASHED",
    remediation: "Restart the runtime.",
  });
  const client = createClient(host);
  try {
    const result = await client.callTool("runtime.captureFrame", {});
    assert.equal(result.isError, true);
    const body = JSON.parse(textOf(result)) as { code: string; message: string; remediation: string };
    assert.deepEqual(body, {
      code: "RUNTIME_CRASHED",
      message: "renderer crashed",
      remediation: "Restart the runtime.",
    });
  } finally {
    await client.close();
  }
});

test("test.runAcceptance refuses bad input before any runtime is launched", async () => {
  const host = recordingHost();
  const client = createClient(host);
  const manifest = { schemaVersion: 1, suite: "forwarding", steps: [] };
  try {
    // An invalid project override is a structured error, not an uncaught exception.
    const badProject = await client.callTool("test.runAcceptance", {
      manifest,
      project: { schemaVersion: 1, projectId: "p", name: "x", scenes: "none" },
    });
    assert.equal(badProject.isError, true);
    assert.ok(textOf(badProject).length > 0);

    // The schema is strict: unknown keys, bad targets and out-of-range timeouts are refused.
    for (const bad of [
      { manifest, surprise: true },
      { manifest, target: "browser" },
      { manifest, timeoutMs: 999 },
      { manifest, timeoutMs: 180_001 },
      { manifest: { ...manifest, schemaVersion: 2 } },
      { manifest: { ...manifest, suite: "" } },
    ]) {
      const result = await client.callTool("test.runAcceptance", bad);
      assert.equal(result.isError, true, `${JSON.stringify(bad)} must be refused`);
    }
    assert.deepEqual(host.calls, [], "the project's own runtime host is never used by acceptance runs");
  } finally {
    await client.close();
  }
});
