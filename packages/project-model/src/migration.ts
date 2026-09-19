import type {
  EntityDefinition,
  ProjectDocument,
  ProjectDocumentV0,
  ProjectDocumentV1,
  SceneDefinition,
} from "./types.js";
import { assertValidProject } from "./validation.js";

export const CURRENT_SCHEMA_VERSION = 1;

type Migration = (input: unknown) => unknown;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function migrateV0ToV1(input: unknown): ProjectDocumentV1 {
  if (!isRecord(input) || input.schemaVersion !== 0) {
    throw new Error("Migration v0→v1 received an invalid v0 document");
  }

  const legacy = input as unknown as ProjectDocumentV0;

  const scenes: SceneDefinition[] = (legacy.scenes ?? []).map((scene) => ({
    id: scene.id,
    name: scene.name,
    entities: (scene.objects ?? []).map((object): EntityDefinition => ({
      id: object.id,
      name: object.name,
      ...(object.parent ? { parentId: object.parent } : {}),
      components: structuredClone(object.components ?? {}),
    })),
  }));

  return {
    schemaVersion: 1,
    projectId: legacy.id,
    name: legacy.name,
    scenes,
  };
}

const migrations = new Map<number, Migration>([[0, migrateV0ToV1]]);

export function migrateProject(input: unknown): ProjectDocument {
  if (!isRecord(input) || typeof input.schemaVersion !== "number") {
    throw new Error("Project document is missing a numeric schemaVersion");
  }

  if (input.schemaVersion > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `Project schema ${input.schemaVersion} is newer than supported schema ${CURRENT_SCHEMA_VERSION}`,
    );
  }

  let working: unknown = structuredClone(input);

  while (
    isRecord(working) &&
    typeof working.schemaVersion === "number" &&
    working.schemaVersion < CURRENT_SCHEMA_VERSION
  ) {
    const migration = migrations.get(working.schemaVersion);
    if (!migration) {
      throw new Error(`No migration registered from schema ${working.schemaVersion}`);
    }
    working = migration(working);
  }

  const project = working as ProjectDocument;
  assertValidProject(project);
  return project;
}
