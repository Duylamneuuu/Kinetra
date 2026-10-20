import type { NavObstacle, NavObstacleInput } from "@kinetra/navigation-recast";

/** JSON shape of `navigation.addObstacle`. Geometric checks stay in `RecastNavMesh`. */

export type NavCylinderObstacleRequest = {
  type: "cylinder";
  position: [number, number, number];
  radius: number;
  height: number;
};

export type NavBoxObstacleRequest = {
  type: "box";
  position: [number, number, number];
  halfExtents: [number, number, number];
  angle: number;
};

export type NavObstacleRequest = NavCylinderObstacleRequest | NavBoxObstacleRequest;

export type NavObstacleState = NavObstacleRequest & { readonly id: string };

function tuple3(value: unknown, name: string): [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3 || value.some((entry) => typeof entry !== "number")) {
    throw new TypeError(`${name} must be a [x, y, z] array of numbers`);
  }
  return [value[0] as number, value[1] as number, value[2] as number];
}

export function parseNavObstacle(value: unknown): NavObstacleRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("navigation.addObstacle requires an object");
  }
  const record = value as Record<string, unknown>;
  const position = tuple3(record.position, "position");
  if (record.type === "cylinder") {
    if (typeof record.radius !== "number" || typeof record.height !== "number") {
      throw new TypeError("cylinder obstacle requires numeric radius and height");
    }
    return { type: "cylinder", position, radius: record.radius, height: record.height };
  }
  if (record.type === "box") {
    if (typeof record.angle !== "number") {
      throw new TypeError("box obstacle requires numeric angle");
    }
    return {
      type: "box",
      position,
      halfExtents: tuple3(record.halfExtents, "halfExtents"),
      angle: record.angle,
    };
  }
  throw new TypeError('navigation obstacle type must be "cylinder" or "box"');
}

export function parseObstacleId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("navigation.removeObstacle requires a non-empty string id");
  }
  return value;
}

export function toNavObstacleInput(request: NavObstacleRequest): NavObstacleInput {
  const position = { x: request.position[0], y: request.position[1], z: request.position[2] };
  if (request.type === "cylinder") {
    return { type: "cylinder", position, radius: request.radius, height: request.height };
  }
  return {
    type: "box",
    position,
    halfExtents: {
      x: request.halfExtents[0],
      y: request.halfExtents[1],
      z: request.halfExtents[2],
    },
    angle: request.angle,
  };
}

export function toNavObstacleState(obstacle: NavObstacle): NavObstacleState {
  const position: [number, number, number] = [obstacle.position.x, obstacle.position.y, obstacle.position.z];
  if (obstacle.type === "cylinder") {
    return { id: obstacle.id, type: "cylinder", position, radius: obstacle.radius, height: obstacle.height };
  }
  return {
    id: obstacle.id,
    type: "box",
    position,
    halfExtents: [obstacle.halfExtents.x, obstacle.halfExtents.y, obstacle.halfExtents.z],
    angle: obstacle.angle,
  };
}
