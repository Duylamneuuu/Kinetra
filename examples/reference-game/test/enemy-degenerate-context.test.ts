import assert from "node:assert/strict";
import test from "node:test";
import {
  ARENA_ENEMY_ANIMATION_GRAPH,
  ArenaEnemyController,
  ArenaPlayerController,
} from "../scripts.js";

/**
 * The enemy and player scripts run inside hosts that may omit services
 * (no transform, no scene, no animation graph). They must degrade to a safe
 * state instead of throwing, and keep the animation in sync with what they do.
 */

interface Logged {
  event: string;
  data: unknown;
}

function logger(logs: Logged[]): (level: string, event: string, data: unknown) => void {
  return (_level, event, data) => {
    logs.push({ event, data });
  };
}

interface PlayCall {
  clip: string;
  options: unknown;
}

function clipAnimation(activeClip: string | undefined, plays: PlayCall[]): any {
  return {
    activeClip,
    play: (clip: string, options: unknown) => {
      plays.push({ clip, options });
    },
  };
}

function sceneWith(
  player: { entityId: string } | undefined,
  position: [number, number, number] | undefined,
): any {
  return {
    findEntityByName: (name: string) => (name === "Player" ? player : undefined),
    getEntityTransform: () => position,
  };
}

const transformAt = (position: [number, number, number]): any => ({
  getPosition: () => position,
  translate: () => undefined,
});

test("player lifecycle hooks log their phase and tolerate a context without log", () => {
  const logs: Logged[] = [];
  const player = new ArenaPlayerController();
  const context: any = { entityId: "p1", log: logger(logs) };
  player.onCreate(context);
  player.onStart(context);
  assert.deepEqual(
    logs.map((entry) => [entry.event, (entry.data as { phase: string }).phase]),
    [
      ["script.lifecycle", "onCreate"],
      ["script.lifecycle", "onStart"],
    ],
  );
  assert.doesNotThrow(() => {
    player.onCreate({ entityId: "p1" } as any);
    player.onStart({ entityId: "p1" } as any);
  });
});

test("enemy onStart without an animation graph plays the starting clip once, looped", () => {
  const plays: PlayCall[] = [];
  const logs: Logged[] = [];
  const enemy = new ArenaEnemyController();
  const context: any = {
    entityId: "e1",
    log: logger(logs),
    animation: clipAnimation(undefined, plays),
  };
  enemy.onCreate(context);
  enemy.onStart(context);
  assert.deepEqual(plays, [{ clip: "walk", options: { loop: true } }]);
  assert.deepEqual(
    logs.map((entry) => (entry.data as { phase: string }).phase),
    ["onCreate", "onStart"],
  );
});

test("enemy onStart with an animation graph initialises it with the arena graph", () => {
  const inits: unknown[] = [];
  const params: Array<[string, unknown]> = [];
  let evaluations = 0;
  const enemy = new ArenaEnemyController();
  enemy.onStart({
    entityId: "e1",
    animation: {
      activeClip: undefined,
      play: () => assert.fail("graph-driven enemies must not call play()"),
      graph: {
        state: "idle",
        init: (definition: unknown) => inits.push(definition),
        setParameter: (name: string, value: unknown) => params.push([name, value]),
        evaluate: () => {
          evaluations++;
        },
      },
    },
  } as any);
  assert.deepEqual(inits, [ARENA_ENEMY_ANIMATION_GRAPH]);
  // desired clip is "walk" while the graph sits in "idle": the enemy must push its parameters.
  assert.deepEqual(params, [
    ["moving", true],
    ["defeated", false],
  ]);
  assert.equal(evaluations, 1);
});

test("enemy leaves a graph alone when it already shows the desired state", () => {
  const enemy = new ArenaEnemyController();
  const context: any = {
    entityId: "e1",
    animation: {
      play: () => assert.fail("must not play"),
      graph: {
        state: "walk",
        setParameter: () => assert.fail("must not set parameters"),
        evaluate: () => assert.fail("must not evaluate"),
      },
    },
  };
  assert.doesNotThrow(() => enemy.onStart(context));
});

test("enemy does not restart a clip that is already active, even its retargeted variant", () => {
  for (const active of ["walk", "walk_retargeted"]) {
    const plays: PlayCall[] = [];
    const enemy = new ArenaEnemyController();
    enemy.onStart({ entityId: "e1", animation: clipAnimation(active, plays) } as any);
    assert.deepEqual(plays, [], `active clip ${active}`);
  }
  const plays: PlayCall[] = [];
  const enemy = new ArenaEnemyController();
  enemy.onStart({ entityId: "e1", animation: clipAnimation("idle", plays) } as any);
  assert.deepEqual(plays, [{ clip: "walk", options: { loop: true } }]);
});

test("enemy onUpdate without transform or scene keeps its state and syncs the clip", () => {
  const plays: PlayCall[] = [];
  const enemy = new ArenaEnemyController();
  enemy.onUpdate({ entityId: "e1", animation: clipAnimation(undefined, plays) } as any, 0.016);
  assert.equal(enemy.state, "chasing");
  assert.deepEqual(plays, [{ clip: "walk", options: { loop: true } }]);

  const noScene = new ArenaEnemyController();
  noScene.onUpdate(
    { entityId: "e1", transform: transformAt([0, 0, 0]), animation: clipAnimation(undefined, []) } as any,
    0.016,
  );
  assert.equal(noScene.state, "chasing");
});

test("enemy goes idle (and plays idle, looped) when the player entity is missing", () => {
  const plays: PlayCall[] = [];
  const enemy = new ArenaEnemyController();
  enemy.onUpdate(
    {
      entityId: "e1",
      transform: transformAt([0, 0, 0]),
      scene: sceneWith(undefined, undefined),
      animation: clipAnimation("walk", plays),
    } as any,
    0.016,
  );
  assert.equal(enemy.state, "idle");
  assert.deepEqual(plays, [{ clip: "idle", options: { loop: true } }]);
});

test("enemy goes idle when the player entity has no transform", () => {
  const plays: PlayCall[] = [];
  const enemy = new ArenaEnemyController();
  enemy.onUpdate(
    {
      entityId: "e1",
      transform: transformAt([0, 0, 0]),
      scene: sceneWith({ entityId: "p" }, undefined),
      animation: clipAnimation("walk", plays),
    } as any,
    0.016,
  );
  assert.equal(enemy.state, "idle");
  assert.deepEqual(plays, [{ clip: "idle", options: { loop: true } }]);
});

test("a defeated enemy ignores updates beyond keeping the defeat clip", () => {
  const plays: PlayCall[] = [];
  const enemy = new ArenaEnemyController();
  enemy.health = 0;
  enemy.state = "defeated";
  enemy.onUpdate(
    {
      entityId: "e1",
      transform: { getPosition: () => assert.fail("must not read position"), translate: () => assert.fail("must not move") },
      scene: sceneWith({ entityId: "p" }, [0, 0, 0]),
      animation: clipAnimation("walk", plays),
    } as any,
    0.016,
  );
  assert.equal(enemy.state, "defeated");
  assert.deepEqual(plays, [{ clip: "defeat", options: { loop: false } }]);
});

test("challengeStarted: only a positive finite multiplier changes the speed, with a floor", () => {
  const cases: Array<[unknown, number]> = [
    [2, 1.6],
    [1.6, 1.28],
    [0, 1.28], // falls back to the default 1.6 multiplier
    [-3, 1.28],
    [Number.NaN, 1.28],
    [Number.POSITIVE_INFINITY, 1.28],
    ["2", 1.28],
    [0.001, 0.01], // rounds to 0, clamped to the minimum speed
  ];
  for (const [multiplier, expectedSpeed] of cases) {
    const enemy = new ArenaEnemyController();
    enemy.onEvent("gameplay.challengeStarted", { multiplier });
    assert.equal(enemy.speed, expectedSpeed, `multiplier ${String(multiplier)}`);
  }
  const noPayload = new ArenaEnemyController();
  noPayload.onEvent("gameplay.challengeStarted");
  assert.equal(noPayload.speed, 1.28);
  const nullPayload = new ArenaEnemyController();
  nullPayload.onEvent("gameplay.challengeStarted", null);
  assert.equal(nullPayload.speed, 1.28);
});

test("a restored enemy state resyncs the animation, and rollback resyncs it back", () => {
  const plays: PlayCall[] = [];
  const enemy = new ArenaEnemyController();
  enemy.onStart({ entityId: "e1", animation: clipAnimation(undefined, plays) } as any);
  plays.length = 0;
  const prepared = enemy.prepareRestoreState({ health: 0, state: "defeated" });
  prepared.commit();
  prepared.rollback();
  // The restore has no context of its own: it falls back to the last one the enemy saw.
  assert.deepEqual(plays, [
    { clip: "defeat", options: { loop: false } },
    { clip: "walk", options: { loop: true } },
  ]);
  assert.equal(enemy.state, "chasing");
  assert.equal(enemy.health, 3);
});
