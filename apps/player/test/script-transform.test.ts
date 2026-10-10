import assert from "node:assert/strict";
import test from "node:test";

import {
  createScriptTransformService,
  type BodyTranslationSink,
  type PositionedObject,
} from "../src/script-transform.js";

class FakeObject implements PositionedObject {
  readonly position = {
    x: 0,
    y: 0,
    z: 0,
    sets: 0,
    set(x: number, y: number, z: number) {
      this.x = x;
      this.y = y;
      this.z = z;
      this.sets += 1;
    },
  };
}

class FakePhysics implements BodyTranslationSink {
  readonly calls: Array<{ id: string; t: { x: number; y: number; z: number }; wake: boolean }> =
    [];
  constructor(private readonly bodies: ReadonlySet<string>) {}
  hasBody(id: string): boolean {
    return this.bodies.has(id);
  }
  setBodyTranslation(id: string, t: { x: number; y: number; z: number }, wake: boolean): void {
    this.calls.push({ id, t, wake });
  }
}

function setup(opts: { withObject?: boolean; withBody?: boolean } = {}) {
  const obj = new FakeObject();
  obj.position.set(1, 2, 3);
  obj.position.sets = 0;
  const physics = new FakePhysics(new Set(opts.withBody === false ? [] : ["e1"]));
  const service = createScriptTransformService("e1", {
    getObject: (id) => (opts.withObject === false || id !== "e1" ? undefined : obj),
    physics,
  });
  return { obj, physics, service };
}

const BAD_VECTORS: unknown[] = [
  [NaN, 0, 0],
  [0, Infinity, 0],
  [0, 0, -Infinity],
  [1, 2],
  [1, 2, 3, 4],
  ["1", 2, 3],
  null,
  undefined,
  { x: 1, y: 2, z: 3 },
];

test("setPosition writes the render object and syncs the physics body", () => {
  const { obj, physics, service } = setup();
  service.setPosition([4, 5, 6]);
  assert.deepEqual([obj.position.x, obj.position.y, obj.position.z], [4, 5, 6]);
  assert.deepEqual(physics.calls, [{ id: "e1", t: { x: 4, y: 5, z: 6 }, wake: true }]);
});

test("setPosition rejects a bad vector without touching the object or the body", () => {
  for (const bad of BAD_VECTORS) {
    const { obj, physics, service } = setup();
    assert.throws(() => service.setPosition(bad as [number, number, number]), RangeError);
    assert.deepEqual([obj.position.x, obj.position.y, obj.position.z], [1, 2, 3]);
    assert.equal(obj.position.sets, 0);
    assert.equal(physics.calls.length, 0);
  }
});

test("translate adds the delta and syncs the physics body", () => {
  const { obj, physics, service } = setup();
  service.translate([1, -1, 0.5]);
  assert.deepEqual([obj.position.x, obj.position.y, obj.position.z], [2, 1, 3.5]);
  assert.deepEqual(physics.calls, [{ id: "e1", t: { x: 2, y: 1, z: 3.5 }, wake: true }]);
});

test("translate rejects a bad delta without touching the object or the body", () => {
  for (const bad of BAD_VECTORS) {
    const { obj, physics, service } = setup();
    assert.throws(() => service.translate(bad as [number, number, number]), RangeError);
    assert.deepEqual([obj.position.x, obj.position.y, obj.position.z], [1, 2, 3]);
    assert.equal(obj.position.sets, 0);
    assert.equal(physics.calls.length, 0);
  }
});

test("translate rejects a bad delta even when the entity has no render object yet", () => {
  const { physics, service } = setup({ withObject: false });
  assert.throws(() => service.translate([NaN, 0, 0]), RangeError);
  assert.equal(physics.calls.length, 0);
  // A valid delta is a harmless no-op, like before.
  assert.doesNotThrow(() => service.translate([1, 0, 0]));
  assert.equal(physics.calls.length, 0);
});

test("setPosition with no render object still moves the physics body, and still validates", () => {
  const { physics, service } = setup({ withObject: false });
  assert.throws(() => service.setPosition([0, NaN, 0]), RangeError);
  assert.equal(physics.calls.length, 0);
  service.setPosition([7, 8, 9]);
  assert.deepEqual(physics.calls, [{ id: "e1", t: { x: 7, y: 8, z: 9 }, wake: true }]);
});

test("translate whose result overflows to Infinity is rejected and leaves the object unchanged", () => {
  const { obj, physics, service } = setup();
  obj.position.set(Number.MAX_VALUE, 0, 0);
  obj.position.sets = 0;
  assert.throws(() => service.translate([Number.MAX_VALUE, 0, 0]), RangeError);
  assert.equal(obj.position.x, Number.MAX_VALUE);
  assert.equal(obj.position.sets, 0);
  assert.equal(physics.calls.length, 0);
});

test("translate on an object whose position is already corrupt throws instead of spreading it", () => {
  const { obj, physics, service } = setup();
  obj.position.x = NaN;
  assert.throws(() => service.translate([1, 0, 0]), RangeError);
  assert.equal(physics.calls.length, 0);
});

test("entities without a physics body (or without physics at all) only move the render object", () => {
  const noBody = setup({ withBody: false });
  noBody.service.setPosition([1, 1, 1]);
  noBody.service.translate([1, 1, 1]);
  assert.equal(noBody.physics.calls.length, 0);
  assert.deepEqual(
    [noBody.obj.position.x, noBody.obj.position.y, noBody.obj.position.z],
    [2, 2, 2],
  );

  const obj = new FakeObject();
  const service = createScriptTransformService("e1", { getObject: () => obj });
  service.setPosition([3, 3, 3]);
  service.translate([1, 0, 0]);
  assert.deepEqual([obj.position.x, obj.position.y, obj.position.z], [4, 3, 3]);
});

test("getPosition reads the render object and falls back to the origin", () => {
  assert.deepEqual(setup().service.getPosition(), [1, 2, 3]);
  assert.deepEqual(setup({ withObject: false }).service.getPosition(), [0, 0, 0]);
});

test("physics is resolved lazily on every call", () => {
  const obj = new FakeObject();
  let physics: FakePhysics | undefined;
  const service = createScriptTransformService("e1", {
    getObject: () => obj,
    get physics() {
      return physics;
    },
  });
  service.setPosition([1, 0, 0]);
  physics = new FakePhysics(new Set(["e1"]));
  service.setPosition([2, 0, 0]);
  assert.deepEqual(physics.calls, [{ id: "e1", t: { x: 2, y: 0, z: 0 }, wake: true }]);
});
