import assert from "node:assert/strict";
import test from "node:test";

import {
  RendererRequestTracker,
  type RendererCommandMessage,
} from "../electron/renderer-requests.js";

function harness(options: { throwOnSend?: boolean; timeoutMs?: number } = {}) {
  const sent: RendererCommandMessage[] = [];
  const tracker = new RendererRequestTracker({
    defaultTimeoutMs: options.timeoutMs ?? 5_000,
    send(message) {
      if (options.throwOnSend) {
        throw new Error("Object has been destroyed");
      }
      sent.push(message);
    },
  });
  return { sent, tracker };
}

test("a reply resolves its request, clears the timer and frees the entry", async () => {
  const { sent, tracker } = harness();
  const request = tracker.call("runtime.query", { a: 1 });
  assert.equal(tracker.pendingCount, 1);
  assert.deepEqual(sent[0], { id: "renderer_1", method: "runtime.query", params: { a: 1 } });

  assert.equal(tracker.respond("renderer_1", { ok: true, result: 42 }), true);
  assert.equal(await request, 42);
  assert.equal(tracker.pendingCount, 0);
  // Late/duplicate replies are ignored rather than settling anything twice.
  assert.equal(tracker.respond("renderer_1", { ok: true, result: 43 }), false);
});

test("an error reply rejects with the renderer message, or a default one", async () => {
  const { tracker } = harness();
  const withMessage = tracker.call("a");
  tracker.respond("renderer_1", { ok: false, error: "boom" });
  await assert.rejects(withMessage, /boom/);

  const withoutMessage = tracker.call("b");
  tracker.respond("renderer_2", { ok: false });
  await assert.rejects(withoutMessage, /Unknown renderer runtime failure/);
});

test("a send that throws rejects at once and leaves no pending entry or live timer", async () => {
  const { tracker } = harness({ throwOnSend: true, timeoutMs: 60_000 });
  await assert.rejects(
    tracker.call("runtime.step"),
    /runtime\.step.*could not be delivered.*destroyed/,
  );
  // A leaked 60 s timer would keep this test process alive; the pending count
  // proves the entry is gone and node:test would hang on the timer otherwise.
  assert.equal(tracker.pendingCount, 0);
});

test("an unanswered request times out and frees its entry", async () => {
  const { tracker } = harness();
  await assert.rejects(tracker.call("slow", {}, 15), /"slow" timed out/);
  assert.equal(tracker.pendingCount, 0);
});

test("rejectAll fails every in-flight request immediately, without waiting for timeouts", async () => {
  const { tracker } = harness({ timeoutMs: 60_000 });
  const first = tracker.call("a");
  const second = tracker.call("b");
  const startedAt = Date.now();

  assert.equal(tracker.rejectAll(new Error("renderer crashed")), 2);

  await assert.rejects(first, /renderer crashed/);
  await assert.rejects(second, /renderer crashed/);
  assert.ok(Date.now() - startedAt < 1_000);
  assert.equal(tracker.pendingCount, 0);
  // Not closed: the renderer may come back (reload), so new calls still go out.
  const next = tracker.call("c");
  assert.equal(tracker.pendingCount, 1);
  tracker.respond("renderer_3", { ok: true, result: "ok" });
  assert.equal(await next, "ok");
});

test("close fails in-flight work and refuses new calls without sending", async () => {
  const { sent, tracker } = harness({ timeoutMs: 60_000 });
  const inflight = tracker.call("a");
  tracker.close(new Error("Kinetra player window is unavailable"));
  await assert.rejects(inflight, /window is unavailable/);
  assert.equal(tracker.closed, true);

  const sentBefore = sent.length;
  await assert.rejects(tracker.call("b"), /window is unavailable/);
  assert.equal(sent.length, sentBefore);
  assert.equal(tracker.pendingCount, 0);
});

test("fail targets one request only", async () => {
  const { tracker } = harness({ timeoutMs: 60_000 });
  const one = tracker.call("a");
  const two = tracker.call("b");
  assert.equal(tracker.fail("renderer_1", new Error("malformed")), true);
  assert.equal(tracker.fail("renderer_1", new Error("again")), false);
  await assert.rejects(one, /malformed/);
  assert.equal(tracker.pendingCount, 1);
  tracker.respond("renderer_2", { ok: true, result: 2 });
  assert.equal(await two, 2);
});
