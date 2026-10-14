import assert from "node:assert/strict";
import test from "node:test";

import { describeBridgeError, normalizeRendererResponse } from "../electron/bridge-protocol.js";
import { RendererRequestTracker } from "../electron/renderer-requests.js";
import { ResourceSwapCancelledError, replaceDisposable } from "../src/resource-swap.js";

// Review follow-up #354 item 2: `ResourceSwapCancelledError` has a stable `code`, but the player
// bridge answered with the raw stack trace ("ResourceSwapCancelledError: ...\n    at ..."), so an
// MCP / IPC caller could only string-match. The code must survive renderer -> main -> bridge reply.

test("describeBridgeError turns a coded error into '<code>: <message>' plus a code field", () => {
  const described = describeBridgeError(new ResourceSwapCancelledError());
  assert.equal(described.code, "runtime.resource.cancelled");
  assert.equal(
    described.error,
    "runtime.resource.cancelled: The runtime was stopped before the replacement resource was ready",
  );
  assert.equal(described.error.includes("\n"), false, "no stack trace in the reply");
});

test("describeBridgeError does not double a code prefix that the message already has", () => {
  const error = Object.assign(new Error("runtime.resource.cancelled: superseded"), {
    code: "runtime.resource.cancelled",
  });
  assert.deepEqual(describeBridgeError(error), {
    error: "runtime.resource.cancelled: superseded",
    code: "runtime.resource.cancelled",
  });
});

test("describeBridgeError keeps the stack of an error without a code, and stringifies non-errors", () => {
  const plain = new Error("boom");
  assert.deepEqual(describeBridgeError(plain), { error: plain.stack ?? "boom" });
  assert.deepEqual(describeBridgeError("text failure"), { error: "text failure" });
  const emptyCode = Object.assign(new Error("x"), { code: "" });
  assert.equal(describeBridgeError(emptyCode).code, undefined, "an empty code is not a code");
  const numericCode = Object.assign(new Error("x"), { code: 42 });
  assert.equal(describeBridgeError(numericCode).code, undefined, "only string codes count");
});

test("describeBridgeError never throws on a hostile error", () => {
  const hostile = new Error("x");
  Object.defineProperty(hostile, "code", {
    get() {
      throw new Error("getter exploded");
    },
  });
  assert.equal(typeof describeBridgeError(hostile).error, "string");
});

test("normalizeRendererResponse keeps a string code and drops anything else", () => {
  assert.deepEqual(
    normalizeRendererResponse({ id: "r1", ok: false, error: "m", code: "runtime.resource.cancelled" }),
    { id: "r1", ok: false, error: "m", code: "runtime.resource.cancelled" },
  );
  assert.deepEqual(normalizeRendererResponse({ id: "r1", ok: false, error: "m", code: 7 }), {
    id: "r1",
    ok: false,
    error: "m",
  });
  assert.deepEqual(normalizeRendererResponse({ id: "r1", ok: false, code: "" }), {
    id: "r1",
    ok: false,
  });
});

test("RendererRequestTracker rejects with an error that carries the renderer's code", async () => {
  const sent: Array<{ id: string }> = [];
  const tracker = new RendererRequestTracker({ send: (message) => void sent.push(message) });
  const pending = tracker.call("navigation.bake", {}, 1_000);
  const first = sent[0];
  assert.ok(first);
  tracker.respond(first.id, {
    ok: false,
    error: "The runtime was stopped before the replacement resource was ready",
    code: "runtime.resource.cancelled",
  });
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { code?: unknown }).code, "runtime.resource.cancelled");
    return true;
  });
});

test("a reply without a code still rejects with a plain error", async () => {
  const sent: Array<{ id: string }> = [];
  const tracker = new RendererRequestTracker({ send: (message) => void sent.push(message) });
  const pending = tracker.call("runtime.query", {}, 1_000);
  const first = sent[0];
  assert.ok(first);
  tracker.respond(first.id, { ok: false, error: "plain" });
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal("code" in error, false);
    return true;
  });
});

test("end to end: a swap cancelled by stop() ends as a structured bridge failure and leaves no mesh", async () => {
  // Mirrors PlayerRuntimeController.bakeNavigation: stop() bumps the generation while the bake is
  // in flight; the replacement is disposed, nothing is installed, the previous state stays cleared.
  let generation = 1;
  let disposed = 0;
  let installed: { dispose(): void } | undefined;
  const state = { hasNavMesh: false };
  const claimed = generation;

  const swap = replaceDisposable({
    current: () => installed,
    create: async () => {
      generation += 1; // stop() ran while the bake was still being built
      return { dispose: () => void (disposed += 1) };
    },
    install: (next) => {
      installed = next;
      state.hasNavMesh = true;
    },
    isCancelled: () => claimed !== generation,
  });

  const failure = await swap.then(
    () => undefined,
    (error: unknown) => describeBridgeError(error),
  );
  assert.ok(failure, "the cancelled swap must reject");
  assert.equal(failure.code, "runtime.resource.cancelled");
  assert.match(failure.error, /^runtime\.resource\.cancelled: /);
  assert.equal(disposed, 1, "the finished replacement is disposed, not installed");
  assert.equal(installed, undefined);
  assert.equal(state.hasNavMesh, false);
});
