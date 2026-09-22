import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const requiredPaths = [
  "state.game.status",
  "state.game.playerHealth",
  "state.game.enemyHealth",
  "state.game.goalReached",
  "state.game.run.status",
  "state.game.objectives.length",
  "state.game.objectives.0.id",
  "state.game.objectives.0.completed",
  "state.game.objectives.1.id",
  "state.game.objectives.2.id",
  "state.game.challenge.active",
  "state.game.challenge.status",
];

const requiredActions = [
  "player.moveForward",
  "player.moveBackward",
  "player.moveLeft",
  "player.moveRight",
  "player.attack",
  "game.pause",
];

test("engine guide lists the Arena observation paths the Electron suites assert", async () => {
  const guide = await readFile(
    repoFile("agents/engine-guide/three.md"),
    "utf8",
  );

  for (const path of requiredPaths) {
    assert.ok(guide.includes(`\`${path}\``), path);
  }
  for (const action of requiredActions) {
    assert.ok(guide.includes(`\`${action}\``), action);
  }
  assert.match(guide, /does not produce this session/);
  assert.match(guide, /not key codes/);
});

function repoFile(relative: string): string {
  let current = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(join(current, "pnpm-workspace.yaml"))) {
      return join(current, relative);
    }
    current = dirname(current);
  }
  throw new Error("Could not find the repository root");
}
