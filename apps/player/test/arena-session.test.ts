import assert from "node:assert/strict";
import test from "node:test";
import { returnToMainMenu, runArenaStart, type ArenaStartSteps } from "../src/arena-session.js";

function makeSteps(overrides: Partial<ArenaStartSteps> = {}) {
  const calls: string[] = [];
  const steps: ArenaStartSteps = {
    stop: async () => {
      calls.push("stop");
    },
    start: async () => {
      calls.push("start");
    },
    loadSave: null,
    enterPlaying: () => {
      calls.push("playing");
    },
    enterMainMenu: () => {
      calls.push("mainMenu");
    },
    ...overrides,
  };
  return { steps, calls };
}

test("a new game stops, starts and enters playing", async () => {
  const { steps, calls } = makeSteps();
  await runArenaStart(steps);
  assert.deepEqual(calls, ["stop", "start", "playing"]);
});

test("Continue loads the save between start and playing", async () => {
  const { steps, calls } = makeSteps({
    loadSave: async () => {
      calls.push("loadSave");
    },
  });
  await runArenaStart(steps);
  assert.deepEqual(calls, ["stop", "start", "loadSave", "playing"]);
});

test("a failing loadSave tears the runtime down, returns to the main menu and rethrows", async () => {
  const failure = new Error("save slot is corrupt");
  const { steps, calls } = makeSteps({
    loadSave: async () => {
      calls.push("loadSave");
      throw failure;
    },
  });
  await assert.rejects(runArenaStart(steps), (error) => error === failure);
  assert.deepEqual(calls, ["stop", "start", "loadSave", "stop", "mainMenu"]);
});

test("a failing start never reports playing", async () => {
  const failure = new Error("scene failed to boot");
  const { steps, calls } = makeSteps({
    start: async () => {
      calls.push("start");
      throw failure;
    },
  });
  await assert.rejects(runArenaStart(steps), (error) => error === failure);
  assert.ok(!calls.includes("playing"));
  assert.equal(calls.at(-1), "mainMenu");
});

test("cleanup errors never mask the start error", async () => {
  const failure = new Error("loadSave failed");
  let stops = 0;
  const { steps, calls } = makeSteps({
    stop: async () => {
      stops += 1;
      if (stops > 1) throw new Error("stop failed during cleanup");
    },
    loadSave: async () => {
      throw failure;
    },
    enterMainMenu: () => {
      calls.push("mainMenu");
      throw new Error("menu failed");
    },
  });
  await assert.rejects(runArenaStart(steps), (error) => error === failure);
  assert.deepEqual(calls, ["start", "mainMenu"]);
});

test("returnToMainMenu stops, refreshes the Continue button and shows the menu in order", async () => {
  const calls: string[] = [];
  await returnToMainMenu({
    stop: async () => {
      calls.push("stop");
    },
    refreshContinueAvailable: async () => {
      calls.push("refresh");
      return true;
    },
    enterMainMenu: () => {
      calls.push("mainMenu");
    },
  });
  assert.deepEqual(calls, ["stop", "refresh", "mainMenu"]);
});

test("returnToMainMenu still shows the menu when stop throws", async () => {
  const failure = new Error("stop failed");
  const calls: string[] = [];
  await assert.rejects(
    returnToMainMenu({
      stop: async () => {
        throw failure;
      },
      refreshContinueAvailable: async () => {
        calls.push("refresh");
        return false;
      },
      enterMainMenu: () => {
        calls.push("mainMenu");
      },
    }),
    (error) => error === failure,
  );
  assert.deepEqual(calls, ["refresh", "mainMenu"]);
});

test("returnToMainMenu still shows the menu when the save probe throws", async () => {
  const calls: string[] = [];
  await assert.rejects(
    returnToMainMenu({
      stop: async () => {
        calls.push("stop");
      },
      refreshContinueAvailable: async () => {
        throw new Error("probe failed");
      },
      enterMainMenu: () => {
        calls.push("mainMenu");
      },
    }),
    /probe failed/,
  );
  assert.deepEqual(calls, ["stop", "mainMenu"]);
});
