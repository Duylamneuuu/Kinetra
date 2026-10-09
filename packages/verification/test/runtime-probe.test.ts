import assert from "node:assert/strict";
import test from "node:test";

import {
  KinetraRuntimeProbe,
  runProcessSmoke,
  type RuntimeProbeHost,
} from "../src/index.js";

type Calls = Array<[string, ...unknown[]]>;

function fakeHost(
  extra: Record<string, unknown> = {},
): { host: RuntimeProbeHost; calls: Calls } {
  const calls: Calls = [];
  const host = {
    start: async (...args: unknown[]) => void calls.push(["start", ...args]),
    stop: async () => void calls.push(["stop"]),
    query: async () => ({
      running: true,
      entities: [
        { entityId: "e1", name: "Hero", model: { assetId: "a1" } },
        { entityId: "e2", name: "Rock" },
      ],
      projectRevision: 3,
    }),
    readLogs: async () => [
      { level: "info", message: "m1" },
      { level: "error", message: "m2", data: { k: 1 } },
    ],
    injectInput: async (e: unknown) => void calls.push(["input", e]),
    captureFrame: async () => ({ available: false, reason: "no gpu" }),
    ...extra,
  };
  return { host: host as unknown as RuntimeProbeHost, calls };
}

const project = { id: "p" } as never;

test("probe start resolves lazy project/assets and omits empty assets", async () => {
  const a = fakeHost();
  await new KinetraRuntimeProbe({
    host: a.host,
    project: async () => project,
    assets: () => ({}),
    initialRevision: 7,
  }).start("s1", 1);
  assert.equal(a.calls[0]?.[2], "s1");
  assert.equal(a.calls[0]?.[3], 7);
  assert.equal(a.calls[0]?.[4], undefined);

  const b = fakeHost();
  await new KinetraRuntimeProbe({
    host: b.host,
    project,
    assets: { x: "AAAA" },
    assetMetadata: async () => ({ x: { fingerprint: "f" } }),
  }).start("s1", 1);
  assert.deepEqual(b.calls[0]?.[4], { x: "AAAA" });
  assert.deepEqual(b.calls[0]?.[5], { assetMetadata: { x: { fingerprint: "f" } } });
});

test("probe degrades truthfully when host lacks optional capabilities", async () => {
  const { host } = fakeHost();
  const probe = new KinetraRuntimeProbe({ host, project });
  assert.deepEqual(await probe.reloadAsset("a"), {
    success: false,
    affectedEntities: [],
    error: "Host does not support reloadAsset",
  });
  assert.equal((await probe.captureSave()).success, false);
  assert.equal((await probe.getSave()).success, false);
  assert.equal((await probe.loadSave({})).success, false);
  assert.equal(await probe.detachModel("e1"), undefined);
  assert.equal(await probe.attachModel("e1", "a"), undefined);
  assert.deepEqual(await probe.metrics(), {});
  await probe.playAnimation("e1", "c");
  await probe.pause();
  await probe.resume();
  await assert.rejects(() => probe.samplePerformance(), /does not support performance/);
});

test("probe snapshot indexes entities and falls back to started scene id", async () => {
  const { host } = fakeHost();
  const probe = new KinetraRuntimeProbe({ host, project });
  await probe.start("scene-a", 0);
  const snap = await probe.snapshot();
  assert.equal(snap.running, true);
  assert.equal(snap.sceneId, "scene-a");
  const state = snap.state as { byName: Record<string, unknown>; byEntityId: Record<string, unknown>; projectRevision: number };
  assert.ok(state.byName["Hero"] && state.byEntityId["e2"]);
  assert.equal(state.projectRevision, 3);
  assert.deepEqual(await probe.queryEntities(), [
    { entityId: "e1", model: { assetId: "a1" } },
    { entityId: "e2", model: undefined },
  ]);
  await probe.stop();
  assert.equal((await probe.snapshot()).sceneId, undefined);
});

test("probe logs, input forwarding, frame capture failure", async () => {
  const { host, calls } = fakeHost();
  const probe = new KinetraRuntimeProbe({ host, project });
  assert.deepEqual(await probe.logs(), [
    { level: "info", message: "m1" },
    { level: "error", message: "m2", data: { k: 1 } },
  ]);
  await probe.input({ action: "jump", phase: "pressed" } as never);
  assert.deepEqual(calls[0], ["input", { action: "jump", phase: "pressed" }]);
  await assert.rejects(() => probe.captureFrame(), /no gpu/);
});

test("probe step falls back to wait; close tolerates stop failure", async () => {
  let stopped = 0;
  let closed = 0;
  const { host } = fakeHost({
    stop: async () => {
      stopped++;
      throw new Error("already closed");
    },
    close: async () => void closed++,
  });
  const probe = new KinetraRuntimeProbe({ host, project });
  const t = performance.now();
  await probe.step(3, 0.01);
  assert.ok(performance.now() - t >= 25);
  await probe.wait(-5);
  await probe.close();
  assert.equal(stopped, 1);
  assert.equal(closed, 1);
});

test("closeOnStop closes host after stop", async () => {
  let closed = 0;
  const { host } = fakeHost({ close: async () => void closed++ });
  await new KinetraRuntimeProbe({ host, project, closeOnStop: true }).stop();
  assert.equal(closed, 1);
});

test("runProcessSmoke captures output, exit code, and times out", async () => {
  const ok = await runProcessSmoke({
    executable: process.execPath,
    args: ["-e", "console.log('hi');console.error('err');process.exit(3)"],
  });
  assert.equal(ok.exitCode, 3);
  assert.match(ok.stdout, /hi/);
  assert.match(ok.stderr, /err/);
  await assert.rejects(
    () =>
      runProcessSmoke({
        executable: process.execPath,
        args: ["-e", "setTimeout(()=>{},10000)"],
        timeoutMs: 200,
      }),
    /timed out after 200ms/,
  );
  await assert.rejects(() =>
    runProcessSmoke({ executable: "/nonexistent/bin-xyz" }),
  );
});
