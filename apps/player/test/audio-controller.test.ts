import assert from "node:assert/strict";
import test from "node:test";

import { PlayerAudioController } from "../src/audio-controller.js";

/**
 * Minimal Web Audio fakes: just enough surface for PlayerAudioController, with a decode step the
 * test can hold open so races (reset while a sound is still loading) are deterministic.
 */
class FakeParam {
  value = 1;
}

class FakeNode {
  connections = new Set<FakeNode>();
  disconnectCalls = 0;
  connect(target: FakeNode): FakeNode {
    this.connections.add(target);
    return target;
  }
  disconnect(): void {
    this.disconnectCalls += 1;
    this.connections.clear();
  }
}

class FakeGain extends FakeNode {
  gain = new FakeParam();
}

class FakeSource extends FakeNode {
  buffer: unknown = null;
  loop = false;
  started = false;
  stopped = false;
  onended: (() => void) | null = null;
  static failStart = false;
  start(): void {
    if (FakeSource.failStart) throw new Error("start refused");
    this.started = true;
  }
  stop(): void {
    this.stopped = true;
  }
  /** Simulates the browser finishing the sound on its own. */
  finish(): void {
    this.onended?.();
  }
}

interface PendingDecode {
  bytes: Uint8Array;
  resolve(buffer: { duration: number; tag: number }): void;
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  state = "running";
  currentTime = 0;
  destination = new FakeNode();
  sources: FakeSource[] = [];
  gains: FakeGain[] = [];
  decodes: PendingDecode[] = [];
  /** When true, decodeAudioData resolves immediately instead of waiting for the test. */
  autoDecode = true;

  constructor() {
    FakeAudioContext.instances.push(this);
  }
  resume(): Promise<void> {
    return Promise.resolve();
  }
  createGain(): FakeGain {
    const gain = new FakeGain();
    this.gains.push(gain);
    return gain;
  }
  createBufferSource(): FakeSource {
    const source = new FakeSource();
    this.sources.push(source);
    return source;
  }
  decodeAudioData(data: ArrayBuffer): Promise<{ duration: number; tag: number }> {
    const bytes = new Uint8Array(data);
    return new Promise((resolve) => {
      const buffer = { duration: 2, tag: bytes[0] ?? -1 };
      if (this.autoDecode) {
        resolve(buffer);
        return;
      }
      this.decodes.push({ bytes, resolve: () => resolve(buffer) });
    });
  }
}

function resolverOf(tag: number): never {
  return { resolve: () => new Uint8Array([tag, 1, 2, 3]) } as never;
}

function withFakeAudio(run: (ctx: () => FakeAudioContext) => Promise<void>): () => Promise<void> {
  return async () => {
    const previousWindow = (globalThis as { window?: unknown }).window;
    FakeAudioContext.instances = [];
    FakeSource.failStart = false;
    (globalThis as { window?: unknown }).window = { AudioContext: FakeAudioContext };
    try {
      await run(() => {
        const ctx = FakeAudioContext.instances[0];
        assert.ok(ctx, "controller should have created an AudioContext");
        return ctx;
      });
    } finally {
      if (previousWindow === undefined) delete (globalThis as { window?: unknown }).window;
      else (globalThis as { window?: unknown }).window = previousWindow;
    }
  };
}

test(
  "a play() still decoding when the controller is re-initialised is dropped and cannot poison the new asset cache",
  withFakeAudio(async (getCtx) => {
    const audio = new PlayerAudioController();
    const ctx = getCtx();
    audio.init(resolverOf(11));

    ctx.autoDecode = false;
    const stale = audio.play({ assetId: "sfx.hit", bus: "sfx" });
    // Let play() reach decodeAudioData.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ctx.decodes.length, 1, "first play should be waiting on decode");

    // Scene change: a new resolver where the same asset id means different audio.
    audio.init(resolverOf(22));
    ctx.decodes[0]?.resolve({ duration: 2, tag: 11 });
    const staleResult = await stale;

    assert.equal(staleResult.success, false, "a play that outlived its init() must not start");
    assert.match(staleResult.error ?? "", /reset|re-?initiali[sz]ed/i);
    assert.equal(audio.getState().activePlaybacks.length, 0, "no orphan playback from the old generation");
    assert.equal(ctx.sources.filter((source) => source.started).length, 0);

    ctx.autoDecode = true;
    const fresh = await audio.play({ assetId: "sfx.hit", bus: "sfx" });
    assert.equal(fresh.success, true);
    const source = ctx.sources.at(-1);
    assert.equal(
      (source?.buffer as { tag: number } | null)?.tag,
      22,
      "the new scene's asset must be decoded, not the stale cached buffer from the old resolver",
    );
  }),
);

test(
  "finished playbacks are pruned so a long session does not accumulate records forever",
  withFakeAudio(async (getCtx) => {
    const audio = new PlayerAudioController();
    const ctx = getCtx();
    audio.init(resolverOf(1));

    const loop = await audio.play({ assetId: "music.loop", bus: "music", loop: true });
    assert.equal(loop.success, true);

    for (let i = 0; i < 150; i++) {
      const result = await audio.play({ assetId: "sfx.click", bus: "sfx" });
      assert.equal(result.success, true);
      ctx.sources.at(-1)?.finish();
    }

    const { activePlaybacks } = audio.getState();
    assert.ok(
      activePlaybacks.length <= 64,
      `finished playbacks must be bounded, got ${activePlaybacks.length} records`,
    );
    const playing = activePlaybacks.filter((entry) => entry.playing);
    assert.equal(playing.length, 1, "the still-playing loop must survive pruning");
    assert.equal(playing[0]?.playbackId, loop.playbackId);
  }),
);

test(
  "finished and stopped playbacks release their Web Audio nodes",
  withFakeAudio(async (getCtx) => {
    const audio = new PlayerAudioController();
    const ctx = getCtx();
    audio.init(resolverOf(1));

    const a = await audio.play({ assetId: "sfx.a", bus: "sfx" });
    const b = await audio.play({ assetId: "sfx.b", bus: "sfx" });
    assert.ok(a.success && b.success);
    const [sourceA, sourceB] = ctx.sources.slice(-2);
    assert.ok(sourceA && sourceB);

    sourceA.finish();
    assert.equal(sourceA.disconnectCalls > 0, true, "a naturally finished source is disconnected");
    assert.equal(audio.stop({ playbackId: b.playbackId as string }).stoppedCount, 1);
    assert.equal(sourceB.stopped, true);
    assert.equal(audio.stop().stoppedCount, 0, "nothing left to stop");
  }),
);

test(
  "a source that refuses to start does not stay wired into the bus graph",
  withFakeAudio(async (getCtx) => {
    const audio = new PlayerAudioController();
    const ctx = getCtx();
    audio.init(resolverOf(1));

    FakeSource.failStart = true;
    const result = await audio.play({ assetId: "sfx.a", bus: "sfx" });
    assert.equal(result.success, false);
    assert.match(result.error ?? "", /start/i);

    const source = ctx.sources.at(-1);
    const gain = ctx.gains.at(-1);
    assert.ok(source && gain);
    assert.equal(source.disconnectCalls > 0, true, "source must be disconnected after a failed start");
    assert.equal(gain.disconnectCalls > 0, true, "instance gain must be disconnected after a failed start");
    assert.equal(audio.getState().activePlaybacks.length, 0);
  }),
);
