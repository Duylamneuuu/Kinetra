import assert from "node:assert/strict";
import { test } from "node:test";
import { ResourceSwapCancelledError, replaceDisposable, type DisposableResource } from "../src/resource-swap.js";

class Fake implements DisposableResource {
  disposed = 0;
  constructor(readonly name: string) {}
  dispose(): void {
    this.disposed += 1;
  }
}

test("a failed build leaves the installed resource alive and untouched", async () => {
  let installed: Fake | undefined = new Fake("old");
  const old = installed;
  await assert.rejects(
    replaceDisposable<Fake>({
      current: () => installed,
      create: () => {
        throw new Error("bad geometry");
      },
      install: (next) => {
        installed = next;
      },
    }),
    /bad geometry/,
  );
  assert.equal(installed, old);
  assert.equal(old.disposed, 0);
});

test("a rejected async build leaves the installed resource alive", async () => {
  let installed: Fake | undefined = new Fake("old");
  const old = installed;
  await assert.rejects(
    replaceDisposable<Fake>({
      current: () => installed,
      create: async () => {
        throw new Error("bad bytes");
      },
      install: (next) => {
        installed = next;
      },
    }),
    /bad bytes/,
  );
  assert.equal(installed, old);
  assert.equal(old.disposed, 0);
});

test("a successful build installs the new resource, then disposes the old one once", async () => {
  let installed: Fake | undefined = new Fake("old");
  const old = installed;
  const events: string[] = [];
  const next = await replaceDisposable<Fake>({
    current: () => installed,
    create: async () => new Fake("new"),
    install: (value) => {
      installed = value;
      events.push(`install:${value.name}:old.disposed=${old.disposed}`);
    },
  });
  assert.equal(installed, next);
  assert.equal(next.disposed, 0);
  assert.equal(old.disposed, 1);
  assert.deepEqual(events, ["install:new:old.disposed=0"]);
});

test("a build finishing after cancellation is disposed, never installed", async () => {
  let installed: Fake | undefined;
  let cancelled = false;
  let built: Fake | undefined;
  await assert.rejects(
    replaceDisposable<Fake>({
      current: () => installed,
      create: async () => {
        cancelled = true; // stop() ran while the bake was in flight
        built = new Fake("late");
        return built;
      },
      install: (value) => {
        installed = value;
      },
      isCancelled: () => cancelled,
    }),
    ResourceSwapCancelledError,
  );
  assert.equal(installed, undefined);
  assert.equal(built?.disposed, 1);
});

test("overlapping swaps dispose the superseded result instead of leaking it", async () => {
  let installed: Fake | undefined;
  const make = (name: string, delay: number) =>
    replaceDisposable<Fake>({
      current: () => installed,
      create: () => new Promise<Fake>((resolve) => setTimeout(() => resolve(new Fake(name)), delay)),
      install: (value) => {
        installed = value;
      },
    });
  const slow = make("slow", 20);
  const fast = make("fast", 1);
  const fastResource = await fast;
  const slowResource = await slow;
  assert.equal(installed, slowResource);
  assert.equal(fastResource.disposed, 1);
  assert.equal(slowResource.disposed, 0);
});

test("re-installing the same instance does not dispose it", async () => {
  const same = new Fake("same");
  let installed: Fake | undefined = same;
  await replaceDisposable<Fake>({
    current: () => installed,
    create: () => same,
    install: (value) => {
      installed = value;
    },
  });
  assert.equal(same.disposed, 0);
});
