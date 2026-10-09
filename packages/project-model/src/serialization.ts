import { cloneProject } from "./clone.js";
import { migrateProject } from "./migration.js";
import type { JsonObject, JsonValue, ProjectDocument } from "./types.js";
import { assertValidProject } from "./validation.js";

/** Locale-independent, deterministic ordering (UTF-16 code units), matching Array.prototype.sort on keys. */
function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }

  if (typeof value === "object" && value !== null) {
    const sorted: JsonObject = {};
    for (const key of Object.keys(value).sort()) {
      const child = value[key];
      if (child !== undefined) {
        // defineProperty, not assignment: a JSON.parse'd "__proto__" key is an own data
        // property, and `sorted["__proto__"] = ...` would set the prototype instead and
        // silently drop the data from the serialized document.
        Object.defineProperty(sorted, key, {
          value: sortJson(child),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
    }
    return sorted;
  }

  return value;
}

const PROJECT_KEY_ORDER = ["schemaVersion", "projectId", "name", "scenes", "metadata"] as const;
const SCENE_KEY_ORDER = ["id", "name", "entities"] as const;
const ENTITY_KEY_ORDER = ["id", "name", "parentId", "components"] as const;

/**
 * Rebuilds an object with its documented keys first (in schema order) and any other own
 * keys after them, sorted. Without this the serialized text depends on the order the
 * properties happened to be assigned in (for example a reparent appends `parentId` after
 * `components`), so the same logical project would produce different bytes and noisy diffs.
 */
function withCanonicalKeyOrder<T extends object>(value: T, order: readonly string[]): T {
  const source = value as Record<string, unknown>;
  const ordered: Record<string, unknown> = {};
  const define = (key: string): void => {
    Object.defineProperty(ordered, key, {
      value: source[key],
      enumerable: true,
      writable: true,
      configurable: true,
    });
  };
  for (const key of order) {
    if (Object.prototype.hasOwnProperty.call(source, key)) define(key);
  }
  for (const key of Object.keys(source).sort(compareCodeUnits)) {
    if (!order.includes(key)) define(key);
  }
  return ordered as T;
}

export function normalizeProject(project: ProjectDocument): ProjectDocument {
  assertValidProject(project);
  const cloned = cloneProject(project);

  cloned.scenes.sort((left, right) => compareCodeUnits(left.id, right.id));

  for (const scene of cloned.scenes) {
    scene.entities.sort((left, right) => compareCodeUnits(left.id, right.id));
    for (const entity of scene.entities) {
      entity.components = sortJson(entity.components) as Record<string, JsonValue>;
    }
    scene.entities = scene.entities.map((entity) => withCanonicalKeyOrder(entity, ENTITY_KEY_ORDER));
  }
  cloned.scenes = cloned.scenes.map((scene) => withCanonicalKeyOrder(scene, SCENE_KEY_ORDER));

  if (cloned.metadata) {
    cloned.metadata = sortJson(cloned.metadata) as JsonObject;
  }

  return withCanonicalKeyOrder(cloned, PROJECT_KEY_ORDER);
}

export function serializeProject(project: ProjectDocument): string {
  return `${JSON.stringify(normalizeProject(project), null, 2)}\n`;
}

export function parseProject(text: string): ProjectDocument {
  return migrateProject(JSON.parse(text) as unknown);
}
