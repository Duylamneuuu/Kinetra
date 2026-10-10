// The `transform` service handed to scripts by the player runtime controller. Extracted from the
// controller so its contract can be tested under plain Node with fake objects: a rejected call
// (non-finite vector) must change neither the render object nor the physics body, regardless of
// whether the entity currently has a render object.

import { assertFiniteVec3, translatedPosition } from "./finite-vec3.js";

export interface PositionedObject {
  readonly position: {
    x: number;
    y: number;
    z: number;
    set(x: number, y: number, z: number): unknown;
  };
}

export interface BodyTranslationSink {
  hasBody(entityId: string): boolean;
  setBodyTranslation(
    entityId: string,
    translation: { x: number; y: number; z: number },
    wakeUp: boolean,
  ): unknown;
}

export interface ScriptTransformDeps {
  getObject(entityId: string): PositionedObject | undefined;
  readonly physics?: BodyTranslationSink | undefined;
}

export interface ScriptTransformService {
  getPosition(): [number, number, number];
  setPosition(position: [number, number, number]): void;
  translate(delta: [number, number, number]): void;
}

export function createScriptTransformService(
  entityId: string,
  deps: ScriptTransformDeps,
): ScriptTransformService {
  const syncBody = (pos: readonly [number, number, number]): void => {
    if (deps.physics?.hasBody(entityId)) {
      deps.physics.setBodyTranslation(entityId, { x: pos[0], y: pos[1], z: pos[2] }, true);
    }
  };
  return {
    getPosition: () => {
      const obj = deps.getObject(entityId);
      return obj ? [obj.position.x, obj.position.y, obj.position.z] : [0, 0, 0];
    },
    setPosition: (rawPos) => {
      // Validate before touching the Three.js object so a rejected call changes nothing.
      const pos = assertFiniteVec3(rawPos, "transform.setPosition position");
      const obj = deps.getObject(entityId);
      if (obj) {
        obj.position.set(pos[0], pos[1], pos[2]);
      }
      syncBody(pos);
    },
    translate: (rawDelta) => {
      // Validated even when the entity has no render object yet, so it rejects exactly like
      // setPosition does instead of silently swallowing a bad vector.
      const delta = assertFiniteVec3(rawDelta, "transform.translate delta");
      const obj = deps.getObject(entityId);
      if (!obj) return;
      const next = translatedPosition(
        [obj.position.x, obj.position.y, obj.position.z],
        delta,
        "transform.translate delta",
      );
      obj.position.set(next[0], next[1], next[2]);
      syncBody(next);
    },
  };
}
