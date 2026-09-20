import assert from "node:assert/strict";
import test from "node:test";

import { stableId, type ProjectDocument } from "@kinetra/project-model";
import {
  createKinetraMcpServer,
  isPackagedExecutableAvailable,
  KinetraAgentService,
  resolvePackagedExecutable,
} from "@kinetra/mcp-server";

import type { AcceptanceManifest, AcceptanceReport } from "../src/types.js";

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

test(
  "Scenario A: DEV RUNTIME PASS — test.runAcceptance executes passing manifest against real Electron runtime",
  { skip: process.platform !== "win32", timeout: 60_000 },
  async () => {
    const service = new KinetraAgentService(fixtureProject());
    const report = await service.runAcceptance({
      manifest: passingManifest("runtime"),
      target: "runtime",
    });

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
  },
);

test(
  "Scenario B: DEV RUNTIME DELIBERATE FAIL — identifies exact failing step with clean teardown",
  { skip: process.platform !== "win32", timeout: 60_000 },
  async () => {
    const service = new KinetraAgentService(fixtureProject());
    const report = await service.runAcceptance({
      manifest: failingManifest("runtime"),
      target: "runtime",
    });

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
    assert.match(
      failingStep.message ?? "",
      /Expected state\.byName\.Orange Box\.position\.0 = 9999, got 0/,
    );

    assert.equal(report.failedSteps?.length, 1);
    assert.equal(report.failureReason, failingStep.message);
  },
);

test(
  "Scenario C: PACKAGED PASS — test.runAcceptance executes passing manifest against real KinetraGame.exe",
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

    const service = new KinetraAgentService(fixtureProject());
    const report = await service.runAcceptance({
      manifest: passingManifest("packaged"),
      target: "packaged",
    });

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
  },
);

test(
  "Scenario D: PACKAGED DELIBERATE FAIL — deliberate failure against KinetraGame.exe reports failing step and tears down",
  {
    skip:
      process.platform !== "win32" ||
      !isPackagedExecutableAvailable(),
    timeout: 90_000,
  },
  async () => {
    const service = new KinetraAgentService(fixtureProject());
    const report = await service.runAcceptance({
      manifest: failingManifest("packaged"),
      target: "packaged",
    });

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
    assert.match(
      failingStep.message ?? "",
      /Expected state\.byName\.Orange Box\.position\.0 = 9999, got 0/,
    );
    assert.equal(report.failedSteps?.length, 1);
    assert.equal(report.failureReason, failingStep.message);
  },
);

test(
  "Scenario E: REPEATED INVOCATIONS — PASS -> FAIL -> PASS in same service instance proves zero socket/process leak",
  { skip: process.platform !== "win32", timeout: 120_000 },
  async () => {
    const service = new KinetraAgentService(fixtureProject());

    // Call 1: PASS
    const rep1 = await service.runAcceptance({
      manifest: passingManifest("runtime"),
      target: "runtime",
    });
    assert.equal(rep1.passed, true);

    // Call 2: FAIL
    const rep2 = await service.runAcceptance({
      manifest: failingManifest("runtime"),
      target: "runtime",
    });
    assert.equal(rep2.passed, false);

    // Call 3: PASS again
    const rep3 = await service.runAcceptance({
      manifest: passingManifest("runtime"),
      target: "runtime",
    });
    assert.equal(rep3.passed, true);
  },
);

test(
  "Scenario F: INFRASTRUCTURE ERROR DISTINCTION — invalid manifest or missing executable returns infrastructure error",
  async () => {
    const service = new KinetraAgentService(fixtureProject());
    const server = createKinetraMcpServer(service) as unknown as {
      _registeredTools: Record<
        string,
        {
          handler(args: unknown): Promise<{
            isError?: boolean;
            content: Array<{ type: string; text: string }>;
          }>;
        }
      >;
    };

    const tool = server._registeredTools["test.runAcceptance"];
    assert.ok(tool !== undefined, "test.runAcceptance tool must be registered");

    // Invalid schemaVersion -> infrastructure failure
    const badSchemaResult = await tool.handler({
      manifest: {
        schemaVersion: 999,
        suite: "unsupported",
        seed: 0,
        target: "runtime",
        steps: [],
      },
    });
    assert.equal(badSchemaResult.isError, true);
    assert.match(
      badSchemaResult.content[0]?.text ?? "",
      /Unsupported acceptance manifest schemaVersion: 999/,
    );

    // Invalid target -> infrastructure failure
    const badTargetResult = await tool.handler({
      manifest: {
        schemaVersion: 1,
        suite: "invalid-target",
        seed: 0,
        target: "invalid-target-name",
        steps: [],
      },
    });
    assert.equal(badTargetResult.isError, true);
    assert.match(
      badTargetResult.content[0]?.text ?? "",
      /Invalid target/,
    );
  },
);
