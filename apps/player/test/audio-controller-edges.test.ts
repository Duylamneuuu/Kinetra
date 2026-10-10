import assert from "node:assert/strict";
import test from "node:test";

import { PlayerAudioController } from "../src/audio-controller.js";

/**
 * Edge contracts of PlayerAudioController that the race/leak tests in audio-controller.test.ts do
 * not cover: unusable assets, bad options, bus routing, stop filters and the reported state.
 * Web Audio is replaced by tiny fakes so everything is deterministic.
 */
class FakeParam {
  value = 1;
}

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
  gain = new FakeParam();
}

class FakeSource extends FakeNode {
  buffer: unknown = null;
  loop = false;
  started = false;
  stopped = false;
  onended: (() => void) | null = null;
  start(): void {
    this.started = true;
  }
  stop(): void {
    this.stopped = true;
  }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  state = "running";
  currentTime = 0;
  destination = new FakeNode();
  sources: FakeSource[] = [];
  gains: FakeGain[] = [];
  decodeCalls = 0;
  failDecode = false;

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
  decodeAudioData(): Promise<{ duration: number }> {
    this.decodeCalls += 1;
    if (this.failDecode) return Promise.reject(new Error("bad audio bytes"));
    return Promise.resolve({ duration: 4 });
  }
}

function resolverOf(value: unknown): never {
  return { resolve: () => value } as never;
}

function withFakeAudio(run: (ctx: () => FakeAudioContext) => Promise<void>): () => Promise<void> {
  return async () => {
    const previousWindow = (globalThis as { window?: unknown }).window;
    FakeAudioContext.instances = [];
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

const BYTES = new Uint8Array([1, 2, 3, 4]);

test(
  "play() before init() and on an unknown bus fails with a structured error instead of throwing",
  withFakeAudio(async () => {
    const audio = new PlayerAudioController();
    const early = await audio.play({ assetId: "sfx.a" });
    assert.equal(early.success, false);
    assert.match(early.error ?? "", /not initialized/i);

    audio.init(resolverOf(BYTES));
    const unknownBus = await audio.play({ assetId: "sfx.a", bus: "no-such-bus" });
    assert.equal(unknownBus.success, false);
    assert.match(unknownBus.error ?? "", /Unknown audio bus "no-such-bus"/);
    assert.equal(audio.getState().activePlaybacks.length, 0);
  }),
);

test("play() reports a missing AudioContext instead of throwing", async () => {
  const previousWindow = (globalThis as { window?: unknown }).window;
  delete (globalThis as { window?: unknown }).window;
  try {
    const audio = new PlayerAudioController();
    audio.init(resolverOf(BYTES));
    const result = await audio.play({ assetId: "sfx.a" });
    assert.equal(result.success, false);
    assert.match(result.error ?? "", /AudioContext is unavailable/);
    assert.equal(audio.getState().initialized, true);
  } finally {
    if (previousWindow !== undefined) (globalThis as { window?: unknown }).window = previousWindow;
  }
});

test(
  "an asset the resolver cannot supply (undefined, empty, wrong type) is reported as not found",
  withFakeAudio(async (getCtx) => {
    for (const unusable of [undefined, null, 42, {}, ""]) {
      const audio = new PlayerAudioController();
      audio.init(resolverOf(unusable));
      const result = await audio.play({ assetId: "sfx.missing" });
      assert.equal(result.success, false, `value ${String(unusable)} must not play`);
      assert.match(result.error ?? "", /sfx\.missing/);
    }
    assert.equal(getCtx().decodeCalls, 0, "nothing unusable may reach decodeAudioData");
  }),
);

test(
  "a resolver that throws or yields invalid base64 produces a failed result, not a rejected promise",
  withFakeAudio(async () => {
    const throwing = new PlayerAudioController();
    throwing.init({
      resolve: () => {
        throw new Error("resolver exploded");
      },
    } as never);
    const thrown = await throwing.play({ assetId: "sfx.boom" });
    assert.equal(thrown.success, false);
    assert.match(thrown.error ?? "", /sfx\.boom/);

    const garbage = new PlayerAudioController();
    garbage.init(resolverOf("%%% not base64 %%%"));
    const invalid = await garbage.play({ assetId: "sfx.garbage" });
    assert.equal(invalid.success, false);
    assert.match(invalid.error ?? "", /sfx\.garbage/);
  }),
);

test(
  "base64 strings, Uint8Array and ArrayBuffer assets are all decoded from a private copy",
  withFakeAudio(async () => {
    const base64 = Buffer.from(BYTES).toString("base64");
    for (const asset of [base64, BYTES, BYTES.buffer.slice(0), Promise.resolve(BYTES)]) {
      const audio = new PlayerAudioController();
      audio.init(resolverOf(asset));
      const result = await audio.play({ assetId: "sfx.a" });
      assert.equal(result.success, true, `asset form ${typeof asset} should play`);
    }
    // One AudioContext per controller, each decoded exactly once.
    assert.equal(FakeAudioContext.instances.length, 4);
    assert.ok(FakeAudioContext.instances.every((ctx) => ctx.decodeCalls === 1));
  }),
);

test(
  "a decode failure is reported with the asset id and does not poison the cache",
  withFakeAudio(async (getCtx) => {
    const audio = new PlayerAudioController();
    const ctx = getCtx();
    audio.init(resolverOf(BYTES));

    ctx.failDecode = true;
    const failed = await audio.play({ assetId: "sfx.bad" });
    assert.equal(failed.success, false);
    assert.match(failed.error ?? "", /Failed to decode audio asset "sfx\.bad": bad audio bytes/);

    ctx.failDecode = false;
    const retried = await audio.play({ assetId: "sfx.bad" });
    assert.equal(retried.success, true, "a later play must decode again, not reuse the failure");
  }),
);

test(
  "a decoded asset is cached: repeated plays decode once",
  withFakeAudio(async (getCtx) => {
    const audio = new PlayerAudioController();
    const ctx = getCtx();
    audio.init(resolverOf(BYTES));
    for (let i = 0; i < 5; i++) {
      assert.equal((await audio.play({ assetId: "sfx.same" })).success, true);
    }
    assert.equal(ctx.decodeCalls, 1);
    assert.equal(ctx.sources.length, 5);
  }),
);

test(
  "per-play gain: negative clamps to 0, NaN/Infinity/non-number fall back to 1, valid values are kept",
  withFakeAudio(async () => {
    const audio = new PlayerAudioController();
    audio.init(resolverOf(BYTES));
    const cases: Array<[unknown, number]> = [
      [0.25, 0.25],
      [-3, 0],
      [Number.NaN, 1],
      [Number.POSITIVE_INFINITY, 1],
      ["loud", 1],
      [undefined, 1],
    ];
    const ids: string[] = [];
    for (const [gain] of cases) {
      const result = await audio.play({ assetId: "sfx.g", gain: gain as number });
      assert.equal(result.success, true);
      ids.push(result.playbackId as string);
    }
    const byId = new Map(audio.getState().activePlaybacks.map((p) => [p.playbackId, p]));
    cases.forEach(([, expected], index) => {
      assert.equal(byId.get(ids[index] as string)?.gain, expected, `case ${index}`);
    });
  }),
);

test(
  "bus gain and mute reach the Web Audio node and the reported effective gain, including child buses",
  withFakeAudio(async (getCtx) => {
    const audio = new PlayerAudioController();
    const ctx = getCtx();
    audio.init(resolverOf(BYTES));
    assert.equal(audio.hasBus("sfx"), true);
    assert.equal(audio.hasBus("nope"), false);

    const played = await audio.play({ assetId: "sfx.a", bus: "sfx", gain: 0.5 });
    assert.equal(played.success, true);
    const playback = () => audio.getState().activePlaybacks[0];

    audio.setBusGain("master", 0.5);
    assert.equal(playback()?.effectiveGain, 0.25, "instance 0.5 x master 0.5 x sfx bus");
    assert.equal(playback()?.muted, false);

    audio.setBusMuted("master", true);
    assert.equal(playback()?.effectiveGain, 0);
    assert.equal(playback()?.muted, true, "a muted parent mutes its children");

    audio.setBusMuted("master", false);
    assert.equal(playback()?.muted, false);
    assert.equal(playback()?.effectiveGain, 0.25, "unmuting restores the previous gain, not 0");

    // The bus nodes were created by init: at least one node follows the 0.5 master gain.
    assert.ok(ctx.gains.some((gain) => gain.gain.value === 0.5));
  }),
);

test(
  "setBusGain / setBusMuted on an unknown bus throw and leave the mixer untouched",
  withFakeAudio(async () => {
    const audio = new PlayerAudioController();
    audio.init(resolverOf(BYTES));
    const before = JSON.stringify(audio.getState().buses);
    assert.throws(() => audio.setBusGain("ghost", 0.3), /Unknown audio bus "ghost"/);
    assert.throws(() => audio.setBusMuted("ghost", true), /Unknown audio bus "ghost"/);
    assert.equal(JSON.stringify(audio.getState().buses), before);
  }),
);

test(
  "stop() filters by playbackId and entityId, and only counts playbacks that were still playing",
  withFakeAudio(async (getCtx) => {
    const audio = new PlayerAudioController();
    const ctx = getCtx();
    audio.init(resolverOf(BYTES));

    const a1 = await audio.play({ assetId: "sfx.a", entityId: "e1" });
    const a2 = await audio.play({ assetId: "sfx.a", entityId: "e1" });
    const b1 = await audio.play({ assetId: "sfx.a", entityId: "e2" });
    assert.ok(a1.success && a2.success && b1.success);

    // Both filters must hold at once.
    assert.equal(
      audio.stop({ playbackId: a1.playbackId as string, entityId: "e2" }).stoppedCount,
      0,
      "playbackId from e1 with entityId e2 matches nothing",
    );
    assert.equal(audio.stop({ entityId: "e1" }).stoppedCount, 2);
    assert.equal(ctx.sources.filter((s) => s.stopped).length, 2);
    assert.equal(audio.stop({ entityId: "e1" }).stoppedCount, 0, "already stopped");
    assert.equal(audio.stop({ playbackId: "playback_does_not_exist" }).stoppedCount, 0);
    assert.equal(audio.stop().stoppedCount, 1, "no filter stops everything still playing");

    const states = audio.getState().activePlaybacks;
    assert.equal(states.length, 3);
    assert.ok(states.every((entry) => entry.playing === false));
  }),
);

test(
  "getState reports elapsed time: one-shots clamp at their duration, loops wrap, stopped sounds sit at 0",
  withFakeAudio(async (getCtx) => {
    const audio = new PlayerAudioController();
    const ctx = getCtx();
    audio.init(resolverOf(BYTES));

    const oneShot = await audio.play({ assetId: "sfx.a" });
    const loop = await audio.play({ assetId: "music.a", loop: true });
    const stopped = await audio.play({ assetId: "sfx.b" });
    audio.stop({ playbackId: stopped.playbackId as string });

    ctx.currentTime = 1;
    let byId = new Map(audio.getState().activePlaybacks.map((p) => [p.playbackId, p]));
    assert.equal(byId.get(oneShot.playbackId as string)?.currentTime, 1);

    ctx.currentTime = 10; // duration is 4
    byId = new Map(audio.getState().activePlaybacks.map((p) => [p.playbackId, p]));
    assert.equal(byId.get(oneShot.playbackId as string)?.currentTime, 4);
    assert.equal(byId.get(loop.playbackId as string)?.currentTime, 2, "10 mod 4");
    assert.equal(byId.get(stopped.playbackId as string)?.currentTime, 0);
    assert.equal(byId.get(loop.playbackId as string)?.loop, true);
    assert.equal(byId.get(loop.playbackId as string)?.duration, 4);
  }),
);

test(
  "reset() stops everything that was playing and in-flight state does not leak into the next init()",
  withFakeAudio(async (getCtx) => {
    const audio = new PlayerAudioController();
    const ctx = getCtx();
    audio.init(resolverOf(BYTES));
    await audio.play({ assetId: "sfx.a" });
    await audio.play({ assetId: "music.a", loop: true });

    audio.reset();
    assert.ok(ctx.sources.every((source) => source.stopped), "reset stops every live source");
    assert.equal(audio.getState().activePlaybacks.filter((p) => p.playing).length, 0);

    audio.init(resolverOf(BYTES));
    assert.equal(audio.stop().stoppedCount, 0);
    const fresh = await audio.play({ assetId: "sfx.a" });
    assert.equal(fresh.success, true);
    assert.equal(audio.getState().activePlaybacks.filter((p) => p.playing).length, 1);
  }),
);
