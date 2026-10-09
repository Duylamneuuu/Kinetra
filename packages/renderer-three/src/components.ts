import type { JsonObject, JsonValue } from "@kinetra/project-model";

export function asObject(value: JsonValue | undefined): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : undefined;
}

export function numberValue(value: JsonValue | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function stringValue(value: JsonValue | undefined, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

export function vec3Value(
  value: JsonValue | undefined,
  fallback: readonly [number, number, number],
): [number, number, number] {
  if (
    Array.isArray(value) &&
    value.length >= 3 &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1]) &&
    Number.isFinite(value[2])
  ) {
    return [value[0] as number, value[1] as number, value[2] as number];
  }

  return [fallback[0], fallback[1], fallback[2]];
}
