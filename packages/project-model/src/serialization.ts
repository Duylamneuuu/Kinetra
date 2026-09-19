import { cloneProject } from "./clone.js";
import { migrateProject } from "./migration.js";
import type { JsonObject, JsonValue, ProjectDocument } from "./types.js";
import { assertValidProject } from "./validation.js";

function sortJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }

  if (typeof value === "object" && value !== null) {
    const sorted: JsonObject = {};
    for (const key of Object.keys(value).sort()) {
      const child = value[key];
      if (child !== undefined) {
        sorted[key] = sortJson(child);
      }
    }
    return sorted;
  }

  return value;
}

export function normalizeProject(project: ProjectDocument): ProjectDocument {
  assertValidProject(project);
  const normalized = cloneProject(project);

  normalized.scenes.sort((left, right) => left.id.localeCompare(right.id));

  for (const scene of normalized.scenes) {
    scene.entities.sort((left, right) => left.id.localeCompare(right.id));
    for (const entity of scene.entities) {
      entity.components = sortJson(entity.components) as Record<string, JsonValue>;
    }
  }

  if (normalized.metadata) {
    normalized.metadata = sortJson(normalized.metadata) as JsonObject;
  }

  return normalized;
}

export function serializeProject(project: ProjectDocument): string {
  return `${JSON.stringify(normalizeProject(project), null, 2)}\n`;
}

export function parseProject(text: string): ProjectDocument {
  return migrateProject(JSON.parse(text) as unknown);
}
