import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FileProjectStore, KinetraAgentService } from "@kinetra/mcp-server";

import {
  AcceptanceRunner,
  ElectronRuntimeHost,
  KinetraRuntimeProbe,
  acceptanceManifestSchema,
  canRunRealElectronTests,
  realElectronLaunchArgs,
  type AcceptanceManifest,
} from "@kinetra/verification";

import { ORB_RUN_ENTITY, ORB_RUN_SCENE_ID, createOrbRunProject } from "../src/index.js";
import { connectMcpClient } from "./mcp-client.js";

/**
 * Real Electron proof for #79: the player can run a second game, selected per
 * start with `game: "orb-run"`, without any Arena-specific code on the path.
 * Skipped (not failed) where Electron cannot launch, like the other real tests.
 */
function createHost(): ElectronRuntimeHost {
  return new ElectronRuntimeHost({
    electronArgs: realElectronLaunchArgs(),
    requestTimeoutMs: 30_000,
    ...(process.env.KINETRA_RUNTIME_EXECUTABLE
      ? { runtimeExecutable: process.env.KINETRA_RUNTIME_EXECUTABLE }
      : {}),
  });
}

function manifest(steps: unknown[], suite: string): AcceptanceManifest {
  return acceptanceManifestSchema.parse({ schemaVersion: 1, suite, seed: 0, target: "runtime", steps });
}

test(
  "Orb Run runs in the real Electron player when the start names game \"orb-run\"",
  { skip: !canRunRealElectronTests(), timeout: 120_000 },
  async (t) => {
    await t.test("collect an orb by injecting player.moveRight and assert the Orb Run manager state", async () => {
      const host = createHost();
      const probe = new KinetraRuntimeProbe({
        host,
        project: () => createOrbRunProject(),
        initialRevision: 0,
        closeOnStop: false,
        game: "orb-run",
      });
      try {
        const report = await new AcceptanceRunner(probe).run(
          manifest(
            [
              { type: "runtime.start", sceneId: ORB_RUN_SCENE_ID },
              { type: "assert.equal", path: "running", expected: true },
              { type: "assert.equal", path: "state.game.status", expected: "playing" },
              { type: "assert.equal", path: "state.game.totalOrbs", expected: 3 },
              { type: "assert.equal", path: "state.game.collectedCount", expected: 0 },
              { type: "assert.equal", path: "state.game.exitUnlocked", expected: false },
              { type: "assert.near", path: "state.byName.Player.position.0", expected: -4, tolerance: 0.01 },
              { type: "input", action: "player.moveRight", phase: "hold", value: 1 },
              { type: "runtime.step", steps: 120 },
              { type: "assert.near", path: "state.byName.Player.position.0", expected: 4, tolerance: 0.1 },
              { type: "assert.equal", path: "state.game.collectedCount", expected: 1 },
              { type: "assert.equal", path: "state.byName.OrbA.gameplay.state.collected", expected: true },
            ],
            "orb-run.electron.collect",
          ),
        );
        const failed = report.steps.find((step) => !step.passed);
        assert.equal(report.passed, true, failed ? `step ${failed.index} (${failed.type}): ${failed.message}` : report.failureReason);

        // `assert.logAbsent` cannot exclude one message, and a CI machine with no
        // audio output (the Windows runner) legitimately reports `audio.playFailed`
        // when the orb pickup cue is played. Every other error is still a failure.
        const logs = await host.readLogs(0);
        const unexpected = logs.filter(
          (entry) => entry.level === "error" && !entry.message.startsWith("audio."),
        );
        assert.deepEqual(unexpected, [], "no error logs other than audio output failures");
      } finally {
        await host.close();
      }
    });

    await t.test("a start without a game keeps the Arena default and leaves Orb Run scripts unresolved", async () => {
      const host = createHost();
      try {
        await host.start(createOrbRunProject(), ORB_RUN_SCENE_ID, 0);
        const logs = await host.readLogs(0);
        const unresolved = logs.filter((entry) => entry.message === "script.resolveFailed");
        assert.equal(unresolved.length, 5, "player, three orbs and manager reference Orb Run scripts; all unresolved");
        const query = (await host.query()) as { gameId?: string; game?: unknown };
        assert.equal(query.gameId, "arena");
        assert.equal(query.game, undefined);
      } finally {
        await host.close();
      }
    });

    await t.test("an unknown game is rejected with a clear error and does not stop the running game", async () => {
      const host = createHost();
      try {
        await host.start(createOrbRunProject(), ORB_RUN_SCENE_ID, 0, undefined, { game: "orb-run" });
        const before = (await host.query()) as { gameId?: string; game?: { collectedCount?: number } };
        assert.equal(before.gameId, "orb-run");

        await assert.rejects(
          host.start(createOrbRunProject(), ORB_RUN_SCENE_ID, 0, undefined, { game: "does-not-exist" }),
          /Unknown game "does-not-exist"/,
        );
        await assert.rejects(
          host.start(createOrbRunProject(), ORB_RUN_SCENE_ID, 0, undefined, { game: "__proto__" }),
          /not valid/,
        );

        const after = (await host.query()) as { running: boolean; gameId?: string; entities: Array<{ entityId: string }> };
        assert.equal(after.running, true, "the failed starts left the running game untouched");
        assert.equal(after.gameId, "orb-run");
        assert.ok(after.entities.some((entity) => entity.entityId === ORB_RUN_ENTITY.player));

        // A game that cannot run this project fails at start with a structured message.
        await assert.rejects(
          host.start(createOrbRunProject(), "scene_does_not_exist", 0, undefined, { game: "orb-run" }),
          /does not exist/,
        );
      } finally {
        await host.close();
      }
    });

    await t.test("MCP test.runAcceptance accepts game and rejects a malformed game id", async () => {
      const dir = await mkdtemp(join(tmpdir(), "orb-run-game-"));
      try {
        const projectPath = join(dir, "orb-run.kinetra.json");
        await new FileProjectStore(projectPath).save(createOrbRunProject());
        const client = connectMcpClient(await KinetraAgentService.fromFile(projectPath));
        const steps = [
          { type: "runtime.start", sceneId: ORB_RUN_SCENE_ID },
          { type: "assert.equal", path: "state.game.totalOrbs", expected: 3 },
          { type: "input", action: "player.moveRight", phase: "hold", value: 1 },
          { type: "runtime.step", steps: 120 },
          { type: "assert.equal", path: "state.game.collectedCount", expected: 1 },
          { type: "runtime.stop" },
        ];
        const report = await client.callJson<{ passed: boolean; failureReason?: string }>("test.runAcceptance", {
          manifest: { schemaVersion: 1, suite: "orb-run.mcp.game", seed: 0, target: "runtime", steps },
          game: "orb-run",
          timeoutMs: 60_000,
        });
        assert.equal(report.passed, true, report.failureReason);

        const rejected = await client.callTool("test.runAcceptance", {
          manifest: { schemaVersion: 1, suite: "orb-run.mcp.badgame", seed: 0, target: "runtime", steps },
          game: "Not A Valid Id",
        });
        assert.equal(rejected.isError, true, "a malformed game id is rejected by the tool schema");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    await t.test("restarting with another game does not leak the previous game's scripts", async () => {
      const host = createHost();
      try {
        await host.start(createOrbRunProject(), ORB_RUN_SCENE_ID, 0, undefined, { game: "orb-run" });
        await host.start(createOrbRunProject(), ORB_RUN_SCENE_ID, 0, undefined, { game: "arena" });
        const query = (await host.query()) as {
          gameId?: string;
          entities: Array<{ entityId: string; gameplay?: { lifecycleState: string; error?: string } }>;
        };
        assert.equal(query.gameId, "arena");
        const player = query.entities.find((entity) => entity.entityId === ORB_RUN_ENTITY.player);
        assert.equal(player?.gameplay?.lifecycleState, "error", "Orb Run's script must not resolve under Arena");
        assert.match(player?.gameplay?.error ?? "", /could not be resolved/);
      } finally {
        await host.close();
      }
    });
  },
);
