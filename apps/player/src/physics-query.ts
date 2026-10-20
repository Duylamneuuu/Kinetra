// Parses bridge params for physics.raycast / physics.shapeCast. Geometric checks (zero
// direction, bad radius, layer range) stay in RapierPhysicsWorld so the bridge and a script
// share one error. This module only rejects a payload that is not the query's shape.

import type { RaycastQuery, ShapeCastQuery, ShapeCastShape, Vec3 } from "@kinetra/physics-rapier";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireVec3(value: unknown, label: string): Vec3 {
  if (!isRecord(value)) {
    throw new TypeError(`${label} must be { x, y, z }`);
  }
  const { x, y, z } = value;
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof z !== "number" ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(z)
  ) {
    throw new TypeError(`${label} must be { x, y, z } with finite numbers`);
  }
  return { x, y, z };
}

function applyFilter<T extends RaycastQuery>(
  query: T,
  params: Record<string, unknown>,
  label: string,
): T {
  if (params.layers !== undefined) {
    if (!Array.isArray(params.layers) || params.layers.some((layer) => typeof layer !== "number")) {
      throw new TypeError(`${label} layers must be an array of numbers`);
    }
    query.layers = params.layers;
  }
  if (params.excludeEntityIds !== undefined) {
    if (
      !Array.isArray(params.excludeEntityIds) ||
      params.excludeEntityIds.some((id) => typeof id !== "string")
    ) {
      throw new TypeError(`${label} excludeEntityIds must be an array of strings`);
    }
    query.excludeEntityIds = params.excludeEntityIds;
  }
  if (params.maxDistance !== undefined) {
    if (typeof params.maxDistance !== "number") {
      throw new TypeError(`${label} maxDistance must be a number`);
    }
    query.maxDistance = params.maxDistance;
  }
  return query;
}

export function parseRaycastParams(params: Record<string, unknown>): RaycastQuery {
  return applyFilter(
    {
      origin: requireVec3(params.origin, "raycast origin"),
      direction: requireVec3(params.direction, "raycast direction"),
    },
    params,
    "raycast",
  );
}

function parseShape(value: unknown): ShapeCastShape {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new TypeError("shapeCast shape must be an object with a type");
  }
  if (value.type === "sphere") {
    if (typeof value.radius !== "number") {
      throw new TypeError("shapeCast sphere radius must be a number");
    }
    return { type: "sphere", radius: value.radius };
  }
  if (value.type === "box") {
    return { type: "box", halfExtents: requireVec3(value.halfExtents, "shapeCast box halfExtents") };
  }
  if (value.type === "capsule") {
    if (typeof value.halfHeight !== "number" || typeof value.radius !== "number") {
      throw new TypeError("shapeCast capsule halfHeight and radius must be numbers");
    }
    return { type: "capsule", halfHeight: value.halfHeight, radius: value.radius };
  }
  throw new TypeError("shapeCast shape.type must be sphere, box or capsule");
}

export function parseShapeCastParams(params: Record<string, unknown>): ShapeCastQuery {
  const query: ShapeCastQuery = {
    shape: parseShape(params.shape),
    origin: requireVec3(params.origin, "shapeCast origin"),
    direction: requireVec3(params.direction, "shapeCast direction"),
  };
  if (params.rotation !== undefined) {
    if (!isRecord(params.rotation)) {
      throw new TypeError("shapeCast rotation must be { x, y, z, w }");
    }
    const { x, y, z, w } = params.rotation;
    if (
      typeof x !== "number" ||
      typeof y !== "number" ||
      typeof z !== "number" ||
      typeof w !== "number"
    ) {
      throw new TypeError("shapeCast rotation must be { x, y, z, w }");
    }
    query.rotation = { x, y, z, w };
  }
  return applyFilter(query, params, "shapeCast");
}
