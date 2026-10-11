import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Luồng C: `ipcRenderer.send` structured-clones its payload and throws for a value that cannot be
// cloned. In the preload's un-awaited async handler that throw was an unhandled rejection: the main
// process never got a reply and the probe / MCP client waited out its whole 10 s timeout.
// The preload only runs inside Electron, so it is loaded here against a fake `electron` module
// whose `ipcRenderer.send` clones like the real one.

const require = createRequire(import.meta.url);
const preloadPath = fileURLToPath(new URL("../electron/preload.cjs", import.meta.url));

interface Sent {
  channel: string;
  payload: unknown;
}

interface Harness {
  sent: Sent[];
  emit(channel: string, payload: unknown): void;
  api: { onCommand(handler: (request: { id: string; method: string; params?: unknown }) => Promise<unknown>): void };
}

function loadPreload(): Harness {
  const sent: Sent[] = [];
  const listeners = new Map<string, Array<(event: unknown, payload: unknown) => void>>();
  const exposed: Record<string, unknown> = {};
  const fakeElectron = {
    contextBridge: {
      exposeInMainWorld(name: string, api: unknown) {
        exposed[name] = api;
      },
    },
    ipcRenderer: {
      invoke: async () => undefined,
      removeAllListeners(channel: string) {
        listeners.delete(channel);
      },
      on(channel: string, listener: (event: unknown, payload: unknown) => void) {
        listeners.set(channel, [...(listeners.get(channel) ?? []), listener]);
      },
      send(channel: string, payload?: unknown) {
        // Like Electron: the payload is structured-cloned (throws on functions, symbols, ...).
        sent.push({ channel, payload: payload === undefined ? undefined : structuredClone(payload) });
      },
    },
  };

  const Module = require("node:module") as { _load: (request: string, ...rest: unknown[]) => unknown };
  const originalLoad = Module._load;
  delete require.cache[preloadPath];
  Module._load = function (request: string, ...rest: unknown[]) {
    return request === "electron" ? fakeElectron : originalLoad.call(this, request, ...rest);
  };
  try {
    require(preloadPath);
  } finally {
    Module._load = originalLoad;
  }
  sent.length = 0;
  return {
    sent,
    emit(channel, payload) {
      for (const listener of listeners.get(channel) ?? []) listener({}, payload);
    },
    api: exposed.kinetraRuntimeBridge as Harness["api"],
  };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test("onCommand announces readiness and replies with the handler result", async () => {
  const harness = loadPreload();
  harness.api.onCommand(async (request) => ({ echoed: request.method }));
  assert.deepEqual(harness.sent.map((entry) => entry.channel), ["kinetra:runtime:renderer-ready"]);

  harness.emit("kinetra:runtime:command", { id: "renderer_1", method: "ping" });
  await settle();
  assert.deepEqual(harness.sent.at(-1), {
    channel: "kinetra:runtime:response",
    payload: { id: "renderer_1", ok: true, result: { echoed: "ping" } },
  });
});

test("a handler error becomes an ok:false reply", async () => {
  const harness = loadPreload();
  harness.api.onCommand(async () => {
    throw new Error("boom");
  });
  harness.emit("kinetra:runtime:command", { id: "renderer_2", method: "x" });
  await settle();
  const reply = harness.sent.at(-1)!.payload as { id: string; ok: boolean; error: string };
  assert.equal(reply.id, "renderer_2");
  assert.equal(reply.ok, false);
  assert.match(reply.error, /boom/);
});

test("a result that cannot be structured-cloned still gets exactly one structured failure reply", async () => {
  const harness = loadPreload();
  harness.api.onCommand(async () => ({ callback: () => 1 }));
  harness.emit("kinetra:runtime:command", { id: "renderer_3", method: "asset.register" });
  await settle();
  const replies = harness.sent.filter((entry) => entry.channel === "kinetra:runtime:response");
  assert.equal(replies.length, 1, "the main process must not be left waiting for its timeout");
  const reply = replies[0]!.payload as { id: string; ok: boolean; error: string };
  assert.equal(reply.id, "renderer_3");
  assert.equal(reply.ok, false);
  assert.match(reply.error, /^BRIDGE_UNCLONEABLE_RESPONSE: /);
});

test("registering onCommand twice replaces the first listener", async () => {
  const harness = loadPreload();
  let first = 0;
  let second = 0;
  harness.api.onCommand(async () => (first += 1));
  harness.api.onCommand(async () => (second += 1));
  harness.emit("kinetra:runtime:command", { id: "renderer_4", method: "x" });
  await settle();
  assert.deepEqual([first, second], [0, 1]);
});
