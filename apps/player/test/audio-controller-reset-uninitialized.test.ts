import assert from "node:assert/strict";
import test from "node:test";

import { PlayerAudioController } from "../src/audio-controller.js";

/**
 * After reset() (runtime stop) the controller has no bus graph. A play() that still found the
 * previous scene's resolver would route the sound straight to the destination, bypassing the
 * master/sfx/music volume the player chose, and serve the dead scene's assets.
 */
class FakeNode {
  connections = new Set<FakeNode>();
  connect(target: FakeNode): FakeNode {
    this.connections.add(target);
    return target;
  }
  disconnect(): void {
    this.connections.clear();
  }
}

class FakeGain extends FakeNode {
  gain = { value: 1 };
}

class FakeSource extends FakeNode {
  buffer: unknown = null;
  loop = false;
  onended: (() => void) | null = null;
  start(): void {}
  stop(): void {}
}

class FakeAudioContext {
  state = "running";
  currentTime = 0;
  destination = new FakeNode();
  resume(): Promise<void> {
    return Promise.resolve();
  }
  createGain(): FakeGain {
    return new FakeGain();
  }
  createBufferSource(): FakeSource {
    return new FakeSource();
  }
  decodeAudioData(): Promise<{ duration: number }> {
    return Promise.resolve({ duration: 1 });
  }
}

const BYTES = new Uint8Array([1, 2, 3, 4]);

test("play() after reset() fails as not initialized instead of using the dead scene's resolver", async () => {
  const previousWindow = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = { AudioContext: FakeAudioContext };
  try {
    const audio = new PlayerAudioController();
    audio.init({ resolve: () => BYTES } as never);
    const live = await audio.play({ assetId: "sfx.a", bus: "sfx" });
    assert.equal(live.success, true, "sanity: playing works while initialized");

    audio.reset();
    assert.equal(audio.getState().initialized, false);

    const afterReset = await audio.play({ assetId: "sfx.a", bus: "sfx" });
    assert.equal(afterReset.success, false, "a stopped runtime must not start sounds");
    assert.match(afterReset.error ?? "", /not initialized/i);
    assert.equal(audio.getState().activePlaybacks.length, 0);

    audio.init({ resolve: () => BYTES } as never);
    const again = await audio.play({ assetId: "sfx.a", bus: "sfx" });
    assert.equal(again.success, true, "init() makes the controller usable again");
  } finally {
    if (previousWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = previousWindow;
  }
});
