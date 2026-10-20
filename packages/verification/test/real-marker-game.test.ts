import assert from "node:assert/strict";
import test from "node:test";

import { MARKER_FINGERPRINT, MARKER_SCRIPT_ID } from "@kinetra/example-marker/game-module";
import { stableId, type ProjectDocument } from "@kinetra/project-model";
import { ARENA_SCENE_ID, createArenaProject } from "@kinetra/reference-game";

import {
  canRunRealElectronTests,
  ElectronRuntimeHost,
  realElectronLaunchArgs,
  type RuntimeQueryResult,
} from "../src/index.js";

const sceneId = stableId("scene", "marker");
const entityId = stableId("entity", "marker-pulse");

function markerProject(): ProjectDocument {
  return {
    schemaVersion: 1,
    projectId: stableId("project", "marker"),
    name: "Marker",
    scenes: [
      {
        id: sceneId,
        name: "Marker",
        entities: [
          {
            id: entityId,
            name: "Pulse",
            components: {
              Primitive: { kind: "box", size: [1, 1, 1], color: "#44cc88" },
              Transform: { position: [0, 0.5, 0] },
              Script: { scriptId: MARKER_SCRIPT_ID, order: 0 },
            },
          },
        ],
      },
    ],
  };
}

function pulsesOf(query: RuntimeQueryResult): number {
  const pulses = query.game?.pulses;
  assert.equal(typeof pulses, "number");
  return pulses as number;
}

test(
  "the Electron player loads the marker game module and keeps Arena as the default",
  { skip: !canRunRealElectronTests(), timeout: 90_000 },
  async () => {
    const host = new ElectronRuntimeHost({
      electronArgs: realElectronLaunchArgs(),
      requestTimeoutMs: 30_000,
      ...(process.env.KINETRA_RUNTIME_EXECUTABLE
        ? { runtimeExecutable: process.env.KINETRA_RUNTIME_EXECUTABLE }
        : {}),
    });
    try {
      await host.start(markerProject(), sceneId, 1, undefined, { game: "marker" });
      const stepped = await host.step(3, 1 / 60);
      assert.equal(stepped.gameId, "marker");
      assert.equal(pulsesOf(stepped), 3);
      assert.equal(stepped.game?.fingerprint, MARKER_FINGERPRINT);
      const pulse = stepped.entities.find((entity) => entity.entityId === entityId);
      assert.equal(pulse?.gameplay?.scriptId, MARKER_SCRIPT_ID);
      assert.equal(pulse?.gameplay?.lifecycleState, "started");

      await assert.rejects(
        () => host.start(markerProject(), sceneId, 1, undefined, { game: "nope" }),
        /\[game\.unknown\]/,
      );
      const still = await host.query();
      assert.equal(still.running, true);
      assert.equal(still.gameId, "marker");
      assert.equal(pulsesOf(still), 3);

      await host.start(createArenaProject(), ARENA_SCENE_ID, 1);
      const arena = await host.query();
      assert.equal(arena.gameId, "arena");
      assert.equal(
        arena.entities.some((entity) => entity.gameplay?.scriptId === MARKER_SCRIPT_ID),
        false,
      );
      assert.equal(
        arena.entities.some((entity) => entity.gameplay?.scriptId === "ArenaGameManager"),
        true,
      );

      await host.start(markerProject(), sceneId, 1);
      const asArena = await host.query();
      assert.equal(asArena.gameId, "arena");
      const unresolved = asArena.entities.find((entity) => entity.entityId === entityId);
      assert.match(unresolved?.gameplay?.error ?? "", /MarkerPulse/);
    } finally {
      await host.close();
    }
  },
);
