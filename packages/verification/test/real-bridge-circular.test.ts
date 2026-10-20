import assert from "node:assert/strict";
import test from "node:test";

import {
  canRunRealElectronTests,
  ElectronRuntimeHost,
  realElectronLaunchArgs,
} from "../src/index.js";

/**
 * #286 item 5: `serializeBridgeMessage` is unit-tested, but the client only sees that failure
 * when `electron/main.ts` `bridgeWrite` sends it. A circular object cannot cross Electron IPC,
 * so the case is a main-process handler result (`testHarness.circularResult`), gated by
 * `KINETRA_RUNTIME_TEST_HOOKS=1`.
 */
test(
  "a circular main-process bridge result fails the client immediately (Refs #286)",
  { skip: !canRunRealElectronTests(), timeout: 90_000 },
  async () => {
    const host = new ElectronRuntimeHost({
      electronArgs: realElectronLaunchArgs(),
      requestTimeoutMs: 30_000,
      enableTestHooks: true,
      ...(process.env.KINETRA_RUNTIME_EXECUTABLE
        ? { runtimeExecutable: process.env.KINETRA_RUNTIME_EXECUTABLE }
        : {}),
    });
    const started = Date.now();
    try {
      await assert.rejects(
        () => host.requestCircularResult(),
        (error: unknown) => {
          assert.ok(error instanceof Error, "the bridge rejects with an Error");
          assert.match(error.message, /^BRIDGE_UNSERIALIZABLE_RESPONSE: /);
          return true;
        },
      );
      const elapsedMs = Date.now() - started;
      assert.ok(
        elapsedMs < 10_000,
        `structured failure arrived in ${elapsedMs}ms; a missed reply would wait ${host.requestTimeoutMs}ms`,
      );
    } finally {
      await host.close();
    }
  },
);
