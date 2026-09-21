import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { stableId, type ProjectDocument } from "@kinetra/project-model";
import {
  createKinetraMcpServer,
  isPackagedExecutableAvailable,
  KinetraAgentService,
  resolvePackagedExecutable,
} from "../src/index.js";
import type { AcceptanceManifest, AcceptanceReport } from "@kinetra/verification";
import {
  createArenaProject,
  ARENA_SCENE_ID,
  arenaAudioAssets,
} from "@kinetra/reference-game";

const sceneId = stableId("scene", "p8-mcp-acceptance");
const boxId = stableId("entity", "p8-mcp-box");
const cameraId = stableId("entity", "p8-mcp-camera");
const lightId = stableId("entity", "p8-mcp-light");

function fixtureProject(): ProjectDocument {
  return {
    schemaVersion: 1,
    projectId: stableId("project", "p8-mcp-acceptance-fixture"),
    name: "P8 MCP Acceptance Fixture",
    scenes: [
      {
        id: sceneId,
        name: "Acceptance Test Scene",
        entities: [
          {
            id: boxId,
            name: "Orange Box",
            components: {
              Primitive: {
                kind: "box",
                size: [1.5, 1.5, 1.5],
                color: "#ff8844",
                roughness: 0.4,
              },
              Transform: {
                position: [0, 0, 0],
              },
            },
          },
          {
            id: cameraId,
            name: "Camera",
            components: {
              Camera: {
                type: "perspective",
                fov: 55,
                near: 0.1,
                far: 100,
              },
              Transform: {
                position: [0, 0, 5],
              },
            },
          },
          {
            id: lightId,
            name: "Directional Light",
            components: {
              Light: {
                kind: "directional",
                color: "#ffffff",
                intensity: 3,
              },
              Transform: {
                position: [3, 5, 4],
              },
            },
          },
        ],
      },
    ],
  };
}

function passingManifest(target: "runtime" | "packaged" = "runtime"): AcceptanceManifest {
  return {
    schemaVersion: 1,
    suite: `p8-mcp-${target}-passing`,
    seed: 42,
    target,
    steps: [
      { type: "runtime.start", sceneId },
      { type: "assert.equal", path: "running", expected: true },
      {
        type: "assert.equal",
        path: "state.byName.Orange Box.position.0",
        expected: 0,
      },
      { type: "input", action: "player.jump", phase: "press" },
      { type: "assert.screenshotValidPng", minBytes: 1_000 },
      { type: "assert.logAbsent", minimumLevel: "error" },
      { type: "runtime.stop" },
    ],
  };
}

function failingManifest(target: "runtime" | "packaged" = "runtime"): AcceptanceManifest {
  return {
    schemaVersion: 1,
    suite: `p8-mcp-${target}-failing`,
    seed: 42,
    target,
    steps: [
      { type: "runtime.start", sceneId },
      {
        type: "assert.equal",
        path: "state.byName.Orange Box.position.0",
        expected: 9999,
      },
      { type: "runtime.stop" },
    ],
  };
}

interface McpCallToolResult {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
}

interface McpJsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: McpCallToolResult;
  error?: { code: number; message: string; data?: unknown };
}

function createMcpTestClient(service: KinetraAgentService) {
  const server = createKinetraMcpServer(service);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();

  let nextId = 1;
  const pending = new Map<number, (res: McpJsonRpcResponse) => void>();

  clientTransport.onmessage = (msg: unknown) => {
    const response = msg as McpJsonRpcResponse;
    if (response && response.id !== undefined && pending.has(response.id)) {
      const resolver = pending.get(response.id)!;
      pending.delete(response.id);
      resolver(response);
    }
  };

  const connectPromise = (async () => {
    await server.connect(serverTransport);
    await clientTransport.start();
  })();

  return {
    async callTool(name: string, args: Record<string, unknown>): Promise<McpCallToolResult> {
      await connectPromise;
      const id = nextId++;
      const response = await new Promise<McpJsonRpcResponse>((resolve) => {
        pending.set(id, resolve);
        clientTransport.send({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: {
            name,
            arguments: args,
          },
        });
      });

      if (response.error) {
        return {
          isError: true,
          content: [{ type: "text", text: `${response.error.message} (code: ${response.error.code})` }],
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

test(
  "Scenario A: DEV RUNTIME PASS — MCP tool test.runAcceptance executes passing manifest over InMemoryTransport",
  { skip: process.platform !== "win32", timeout: 60_000 },
  async () => {
    const client = createMcpTestClient(new KinetraAgentService(fixtureProject()));

    try {
      const result = await client.callTool("test.runAcceptance", {
        manifest: passingManifest("runtime"),
        target: "runtime",
      });

      assert.notEqual(result.isError, true, "Tool call must not return isError");
      assert.ok(result.content.length > 0);

      const report = JSON.parse(result.content[0]?.text ?? "{}") as AcceptanceReport;
      assert.equal(report.passed, true);
      assert.equal(report.suite, "p8-mcp-runtime-passing");
      assert.equal(report.target, "runtime");
      assert.ok(typeof report.durationMs === "number" && report.durationMs > 0);
      assert.equal(report.steps.length, 7);
      assert.ok(report.steps.every((s) => s.passed));
      assert.deepEqual(report.failedSteps, []);
      assert.equal(report.failureReason, undefined);

      // Verify structured observations proving target and process evidence
      assert.equal(report.observations?.target, "runtime");
      const hostInfo = report.observations?.hostInfo as
        | { isPackaged?: boolean; execPath?: string }
        | undefined;
      assert.ok(hostInfo !== undefined);
      assert.equal(hostInfo.isPackaged, false);
      assert.ok(
        typeof hostInfo.execPath === "string" &&
          /electron(\.exe)?$/i.test(hostInfo.execPath),
        `Expected execPath to be electron, got: ${hostInfo.execPath}`,
      );
    } finally {
      await client.close();
    }
  },
);

test(
  "Scenario B: DEV RUNTIME DELIBERATE FAIL — MCP tool returns passed: false with structured expected/actual (not isError)",
  { skip: process.platform !== "win32", timeout: 60_000 },
  async () => {
    const client = createMcpTestClient(new KinetraAgentService(fixtureProject()));

    try {
      const result = await client.callTool("test.runAcceptance", {
        manifest: failingManifest("runtime"),
        target: "runtime",
      });

      // Crucial: normal assertion failure in test suite must NOT set MCP tool isError: true
      assert.notEqual(result.isError, true, "Assertion failure in suite must not set isError: true");
      assert.ok(result.content.length > 0);

      const report = JSON.parse(result.content[0]?.text ?? "{}") as AcceptanceReport;
      assert.equal(report.passed, false);
      assert.equal(report.suite, "p8-mcp-runtime-failing");
      assert.equal(report.target, "runtime");
      assert.equal(report.steps.length, 2);
      assert.equal(report.steps[0]?.passed, true);

      const failingStep = report.steps[1];
      assert.ok(failingStep !== undefined);
      assert.equal(failingStep.passed, false);
      assert.equal(failingStep.index, 1);
      assert.equal(failingStep.type, "assert.equal");
      assert.equal(failingStep.expected, 9999);
      assert.equal(failingStep.actual, 0);
      assert.match(
        failingStep.message ?? "",
        /Expected state\.byName\.Orange Box\.position\.0 = 9999, got 0/,
      );

      assert.equal(report.failedSteps?.length, 1);
      assert.equal(report.failedSteps?.[0]?.expected, 9999);
      assert.equal(report.failedSteps?.[0]?.actual, 0);
      assert.equal(report.failureReason, failingStep.message);
    } finally {
      await client.close();
    }
  },
);

test(
  "Scenario C: PACKAGED PASS — MCP tool test.runAcceptance executes passing manifest against real KinetraGame.exe",
  {
    skip:
      process.platform !== "win32" ||
      !isPackagedExecutableAvailable(),
    timeout: 90_000,
  },
  async () => {
    const resolution = resolvePackagedExecutable();
    assert.ok(
      resolution.path.endsWith("KinetraGame.exe"),
      `Expected KinetraGame.exe, got: ${resolution.path}`,
    );

    const client = createMcpTestClient(new KinetraAgentService(fixtureProject()));

    try {
      const result = await client.callTool("test.runAcceptance", {
        manifest: passingManifest("packaged"),
        target: "packaged",
      });

      assert.notEqual(result.isError, true, "Tool call must not return isError");
      assert.ok(result.content.length > 0);

      const report = JSON.parse(result.content[0]?.text ?? "{}") as AcceptanceReport;
      assert.equal(report.passed, true);
      assert.equal(report.suite, "p8-mcp-packaged-passing");
      assert.equal(report.target, "packaged");
      assert.ok(typeof report.durationMs === "number" && report.durationMs > 0);
      assert.equal(report.steps.length, 7);
      assert.ok(report.steps.every((s) => s.passed));
      assert.deepEqual(report.failedSteps, []);
      assert.equal(report.failureReason, undefined);

      // Verify structured observations truthfully prove that packaged binary ran
      assert.equal(report.observations?.target, "packaged");
      const hostInfo = report.observations?.hostInfo as
        | { isPackaged?: boolean; execPath?: string }
        | undefined;
      assert.ok(hostInfo !== undefined);
      assert.equal(hostInfo.isPackaged, true);
      assert.ok(
        typeof hostInfo.execPath === "string" &&
          /KinetraGame\.exe$/i.test(hostInfo.execPath),
        `Expected execPath to end with KinetraGame.exe, got: ${hostInfo.execPath}`,
      );
    } finally {
      await client.close();
    }
  },
);

test(
  "Scenario D: PACKAGED DELIBERATE FAIL — deliberate failure against KinetraGame.exe returns structured evidence and clean teardown",
  {
    skip:
      process.platform !== "win32" ||
      !isPackagedExecutableAvailable(),
    timeout: 90_000,
  },
  async () => {
    const client = createMcpTestClient(new KinetraAgentService(fixtureProject()));

    try {
      const result = await client.callTool("test.runAcceptance", {
        manifest: failingManifest("packaged"),
        target: "packaged",
      });

      assert.notEqual(result.isError, true, "Deliberate suite failure must return isError: false");
      assert.ok(result.content.length > 0);

      const report = JSON.parse(result.content[0]?.text ?? "{}") as AcceptanceReport;
      assert.equal(report.passed, false);
      assert.equal(report.suite, "p8-mcp-packaged-failing");
      assert.equal(report.target, "packaged");
      assert.equal(report.steps.length, 2);
      assert.equal(report.steps[0]?.passed, true);

      const failingStep = report.steps[1];
      assert.ok(failingStep !== undefined);
      assert.equal(failingStep.passed, false);
      assert.equal(failingStep.index, 1);
      assert.equal(failingStep.type, "assert.equal");
      assert.equal(failingStep.expected, 9999);
      assert.equal(failingStep.actual, 0);
      assert.match(
        failingStep.message ?? "",
        /Expected state\.byName\.Orange Box\.position\.0 = 9999, got 0/,
      );
      assert.equal(report.failedSteps?.length, 1);
      assert.equal(report.failureReason, failingStep.message);
    } finally {
      await client.close();
    }
  },
);

test(
  "Scenario E: REPEATED INVOCATIONS — PASS -> FAIL -> PASS over single MCP client connection proves zero leak",
  { skip: process.platform !== "win32", timeout: 120_000 },
  async () => {
    const client = createMcpTestClient(new KinetraAgentService(fixtureProject()));

    try {
      // Call 1: PASS
      const res1 = await client.callTool("test.runAcceptance", {
        manifest: passingManifest("runtime"),
        target: "runtime",
      });
      assert.notEqual(res1.isError, true);
      const rep1 = JSON.parse(res1.content[0]?.text ?? "{}") as AcceptanceReport;
      assert.equal(rep1.passed, true);

      // Call 2: FAIL
      const res2 = await client.callTool("test.runAcceptance", {
        manifest: failingManifest("runtime"),
        target: "runtime",
      });
      assert.notEqual(res2.isError, true);
      const rep2 = JSON.parse(res2.content[0]?.text ?? "{}") as AcceptanceReport;
      assert.equal(rep2.passed, false);

      // Call 3: PASS again
      const res3 = await client.callTool("test.runAcceptance", {
        manifest: passingManifest("runtime"),
        target: "runtime",
      });
      assert.notEqual(res3.isError, true);
      const rep3 = JSON.parse(res3.content[0]?.text ?? "{}") as AcceptanceReport;
      assert.equal(rep3.passed, true);
    } finally {
      await client.close();
    }
  },
);

test(
  "Scenario F: SCHEMA REJECTION — Unknown step type (shell.exec) rejected at MCP boundary",
  async () => {
    const client = createMcpTestClient(new KinetraAgentService(fixtureProject()));

    try {
      const result = await client.callTool("test.runAcceptance", {
        manifest: {
          schemaVersion: 1,
          suite: "malicious-step",
          seed: 0,
          target: "runtime",
          steps: [
            {
              type: "shell.exec",
              command: "whoami",
            },
          ],
        },
      });

      assert.equal(result.isError, true, "Unknown step type must be rejected with isError: true");
      const errorText = result.content[0]?.text ?? "";
      assert.match(
        errorText,
        /Invalid discriminator value|Input validation error/i,
        `Expected validation error, got: ${errorText}`,
      );
    } finally {
      await client.close();
    }
  },
);

test(
  "Scenario G: SCHEMA REJECTION — Malformed known step (assert.near with string) rejected at MCP boundary",
  async () => {
    const client = createMcpTestClient(new KinetraAgentService(fixtureProject()));

    try {
      const result = await client.callTool("test.runAcceptance", {
        manifest: {
          schemaVersion: 1,
          suite: "malformed-step",
          seed: 0,
          target: "runtime",
          steps: [
            {
              type: "assert.near",
              path: "state.player.x",
              expected: "not-a-number",
              tolerance: 0.1,
            },
          ],
        },
      });

      assert.equal(result.isError, true, "Malformed step must be rejected with isError: true");
      const errorText = result.content[0]?.text ?? "";
      assert.match(
        errorText,
        /expected number|Input validation error/i,
        `Expected validation error, got: ${errorText}`,
      );
    } finally {
      await client.close();
    }
  },
);

test(
  "Scenario H: SCHEMA REJECTION — Arbitrary top-level argument (exePath) rejected by strict schema",
  async () => {
    const client = createMcpTestClient(new KinetraAgentService(fixtureProject()));

    try {
      const result = await client.callTool("test.runAcceptance", {
        manifest: passingManifest("runtime"),
        exePath: "C:\\Windows\\System32\\cmd.exe",
      });

      assert.equal(result.isError, true, "Unrecognized top-level argument must be rejected with isError: true");
      const errorText = result.content[0]?.text ?? "";
      assert.match(
        errorText,
        /Unrecognized key|Input validation error/i,
        `Expected unrecognized key error, got: ${errorText}`,
      );
    } finally {
      await client.close();
    }
  },
);

test(
  "Scenario I: INFRASTRUCTURE ERROR — Missing packaged executable returns isError: true",
  async () => {
    const origEnv = process.env.KINETRA_RUNTIME_EXECUTABLE;
    process.env.KINETRA_RUNTIME_EXECUTABLE = "C:\\nonexistent\\KinetraGame.exe";

    const client = createMcpTestClient(new KinetraAgentService(fixtureProject()));

    try {
      const result = await client.callTool("test.runAcceptance", {
        manifest: passingManifest("packaged"),
        target: "packaged",
      });

      assert.equal(result.isError, true, "Missing packaged executable must return isError: true");
      const errorText = result.content[0]?.text ?? "";
      assert.match(
        errorText,
        /CONFIGURED_EXECUTABLE_NOT_FOUND|not found/i,
        `Expected executable not found error, got: ${errorText}`,
      );
    } finally {
      if (origEnv !== undefined) {
        process.env.KINETRA_RUNTIME_EXECUTABLE = origEnv;
      } else {
        delete process.env.KINETRA_RUNTIME_EXECUTABLE;
      }
      await client.close();
    }
  },
);

test(
  "Scenario J: INFRASTRUCTURE ERROR — Invalid project fixture override rejected by assertValidProject()",
  async () => {
    const client = createMcpTestClient(new KinetraAgentService(fixtureProject()));

    try {
      const result = await client.callTool("test.runAcceptance", {
        manifest: passingManifest("runtime"),
        project: {
          schemaVersion: 999,
          projectId: "bad",
          name: "Invalid",
          scenes: "not-an-array",
        },
      });

      assert.equal(result.isError, true, "Invalid project fixture must return isError: true");
      const errorText = result.content[0]?.text ?? "";
      assert.match(
        errorText,
        /Project validation failed|schemaVersion|scenes/i,
        `Expected project validation failure, got: ${errorText}`,
      );
    } finally {
      await client.close();
    }
  },
);

test(
  "Scenario K: PACKAGED ARENA WIN — MCP tool test.runAcceptance executes reference game against real KinetraGame.exe",
  {
    skip:
      process.platform !== "win32" ||
      !isPackagedExecutableAvailable(),
    timeout: 90_000,
  },
  async () => {
    const resolution = resolvePackagedExecutable();
    assert.ok(
      resolution.path.endsWith("KinetraGame.exe"),
      `Expected KinetraGame.exe, got: ${resolution.path}`,
    );

    const client = createMcpTestClient(new KinetraAgentService(fixtureProject()));

    const arenaManifest: AcceptanceManifest = {
      schemaVersion: 1,
      suite: "arena-packaged-win",
      seed: 42,
      target: "packaged",
      steps: [
        { type: "runtime.start", sceneId: ARENA_SCENE_ID },
        { type: "assert.equal", path: "running", expected: true },
        { type: "assert.equal", path: "sceneId", expected: ARENA_SCENE_ID },
        { type: "assert.equal", path: "state.navigation.hasNavMesh", expected: true },
        { type: "assert.equal", path: "state.game.status", expected: "playing" },
        { type: "assert.equal", path: "state.game.playerHealth", expected: 3 },
        { type: "input", action: "player.moveRight", phase: "hold", value: 1 },
        { type: "runtime.step", steps: 10 },
        { type: "assert.equal", path: "state.byName.Player.position.0", expected: 5 },
        { type: "assert.equal", path: "state.game.goalReached", expected: true },
        { type: "assert.equal", path: "state.game.status", expected: "won" },
        { type: "assert.screenshotValidPng" },
        { type: "runtime.stop" },
      ],
    };

    try {
      const result = await client.callTool("test.runAcceptance", {
        manifest: arenaManifest,
        target: "packaged",
        project: createArenaProject(),
        assets: arenaAudioAssets,
      });

      assert.notEqual(result.isError, true, "Tool call must not return isError");
      assert.ok(result.content.length > 0);

      const report = JSON.parse(result.content[0]?.text ?? "{}") as AcceptanceReport;
      assert.equal(report.passed, true, `Report must pass: ${report.failureReason}`);
      assert.equal(report.suite, "arena-packaged-win");
      assert.equal(report.target, "packaged");
      assert.equal(report.observations?.target, "packaged");

      const hostInfo = report.observations?.hostInfo as
        | { isPackaged?: boolean; execPath?: string }
        | undefined;
      assert.ok(hostInfo !== undefined);
      assert.equal(hostInfo.isPackaged, true);
      assert.ok(
        typeof hostInfo.execPath === "string" &&
          /KinetraGame\.exe$/i.test(hostInfo.execPath),
        `Expected execPath to end with KinetraGame.exe, got: ${hostInfo.execPath}`,
      );
    } finally {
      await client.close();
    }
  },
);
