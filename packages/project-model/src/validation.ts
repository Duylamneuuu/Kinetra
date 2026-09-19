import type {
  EntityDefinition,
  JsonValue,
  ProjectDocument,
  SceneDefinition,
} from "./types.js";

export interface ValidationIssue {
  path: string;
  code: string;
  message: string;
}

export class ProjectValidationError extends Error {
  readonly issues: ValidationIssue[];

  constructor(issues: ValidationIssue[]) {
    super(
      `Project validation failed with ${issues.length} issue${issues.length === 1 ? "" : "s"}`,
    );
    this.name = "ProjectValidationError";
    this.issues = issues;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return typeof value !== "number" || Number.isFinite(value);
  }

  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }

  if (isRecord(value)) {
    return Object.values(value).every(isJsonValue);
  }

  return false;
}

function validateEntity(
  entity: EntityDefinition,
  scene: SceneDefinition,
  path: string,
  issues: ValidationIssue[],
): void {
  if (!entity.id) {
    issues.push({ path: `${path}.id`, code: "entity.id.empty", message: "Entity id is required" });
  }

  if (!entity.name) {
    issues.push({
      path: `${path}.name`,
      code: "entity.name.empty",
      message: "Entity name is required",
    });
  }

  if (!isRecord(entity.components)) {
    issues.push({
      path: `${path}.components`,
      code: "entity.components.invalid",
      message: "Entity components must be an object",
    });
  } else {
    for (const [componentName, componentValue] of Object.entries(entity.components)) {
      if (!componentName) {
        issues.push({
          path: `${path}.components`,
          code: "component.name.empty",
          message: "Component names must not be empty",
        });
      }

      if (!isJsonValue(componentValue)) {
        issues.push({
          path: `${path}.components.${componentName}`,
          code: "component.value.not-json",
          message: "Component data must be valid JSON data",
        });
      }
    }
  }

  if (entity.parentId && !scene.entities.some((candidate) => candidate.id === entity.parentId)) {
    issues.push({
      path: `${path}.parentId`,
      code: "entity.parent.missing",
      message: `Parent entity "${entity.parentId}" does not exist in scene "${scene.id}"`,
    });
  }
}

function validateParentCycles(scene: SceneDefinition, issues: ValidationIssue[]): void {
  const byId = new Map(scene.entities.map((entity) => [entity.id, entity]));

  for (const entity of scene.entities) {
    const visited = new Set<string>([entity.id]);
    let cursor = entity.parentId;

    while (cursor) {
      if (visited.has(cursor)) {
        issues.push({
          path: `scenes[${scene.id}].entities[${entity.id}].parentId`,
          code: "entity.parent.cycle",
          message: `Parent cycle detected for entity "${entity.id}"`,
        });
        break;
      }

      visited.add(cursor);
      cursor = byId.get(cursor)?.parentId;
    }
  }
}

export function validateProject(project: ProjectDocument): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (project.schemaVersion !== 1) {
    issues.push({
      path: "schemaVersion",
      code: "project.schema.unsupported",
      message: `Expected schemaVersion 1, received ${String(project.schemaVersion)}`,
    });
  }

  if (!project.projectId) {
    issues.push({
      path: "projectId",
      code: "project.id.empty",
      message: "Project id is required",
    });
  }

  if (!project.name) {
    issues.push({ path: "name", code: "project.name.empty", message: "Project name is required" });
  }

  const sceneIds = new Set<string>();
  const entityIds = new Set<string>();

  project.scenes.forEach((scene, sceneIndex) => {
    const scenePath = `scenes[${sceneIndex}]`;

    if (!scene.id) {
      issues.push({ path: `${scenePath}.id`, code: "scene.id.empty", message: "Scene id is required" });
    } else if (sceneIds.has(scene.id)) {
      issues.push({
        path: `${scenePath}.id`,
        code: "scene.id.duplicate",
        message: `Duplicate scene id "${scene.id}"`,
      });
    }
    sceneIds.add(scene.id);

    const localIds = new Set<string>();
    scene.entities.forEach((entity, entityIndex) => {
      const entityPath = `${scenePath}.entities[${entityIndex}]`;

      if (localIds.has(entity.id)) {
        issues.push({
          path: `${entityPath}.id`,
          code: "entity.id.duplicate-in-scene",
          message: `Duplicate entity id "${entity.id}" in scene "${scene.id}"`,
        });
      }
      localIds.add(entity.id);

      if (entityIds.has(entity.id)) {
        issues.push({
          path: `${entityPath}.id`,
          code: "entity.id.duplicate-in-project",
          message: `Entity id "${entity.id}" must be globally unique within a project`,
        });
      }
      entityIds.add(entity.id);
      validateEntity(entity, scene, entityPath, issues);
    });

    validateParentCycles(scene, issues);
  });

  if (project.metadata && !isJsonValue(project.metadata)) {
    issues.push({
      path: "metadata",
      code: "project.metadata.not-json",
      message: "Project metadata must contain JSON-compatible values only",
    });
  }

  return issues;
}

export function assertValidProject(project: ProjectDocument): void {
  const issues = validateProject(project);
  if (issues.length > 0) {
    throw new ProjectValidationError(issues);
  }
}
