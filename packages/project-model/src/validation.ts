import { validateBuiltInComponent } from "./components.js";
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
  /** How to fix it. Present on built-in component issues. */
  remediation?: string;
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Deepest nesting accepted in component/metadata JSON (far beyond any real document). */
export const MAX_JSON_DEPTH = 512;

/**
 * True when the value round-trips through JSON unchanged: finite numbers, plain
 * objects, dense arrays, no cycles. Map/Set/Date/class instances, sparse arrays and
 * cyclic graphs are rejected instead of silently serializing to something else
 * (or overflowing the stack).
 */
function isJsonValue(
  value: unknown,
  ancestors: Set<object> = new Set(),
  depth = 0,
): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return typeof value !== "number" || Number.isFinite(value);
  }

  if (typeof value !== "object") {
    return false;
  }

  // Documents arrive as untrusted JSON; unbounded nesting would overflow the stack here
  // (and later in JSON.stringify/structuredClone) instead of yielding a structured issue.
  if (ancestors.has(value) || depth >= MAX_JSON_DEPTH) {
    return false;
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value) || !isJsonValue(value[index], ancestors, depth + 1)) return false;
      }
      return true;
    }

    if (isPlainObject(value)) {
      return Object.values(value).every((child) => isJsonValue(child, ancestors, depth + 1));
    }

    return false;
  } finally {
    ancestors.delete(value);
  }
}

function validateEntity(
  entity: EntityDefinition,
  scene: SceneDefinition,
  sceneEntityIds: ReadonlySet<unknown>,
  path: string,
  issues: ValidationIssue[],
): void {
  if (!isNonEmptyString(entity.id)) {
    issues.push({ path: `${path}.id`, code: "entity.id.empty", message: "Entity id is required" });
  }

  if (!isNonEmptyString(entity.name)) {
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
      } else {
        for (const problem of validateBuiltInComponent(componentName, componentValue)) {
          issues.push({
            path: `${path}.components.${componentName}${problem.field ? `.${problem.field}` : ""}`,
            code: problem.code,
            message: problem.message,
            remediation: problem.remediation,
          });
        }
      }
    }
  }

  if (entity.parentId !== undefined && !isNonEmptyString(entity.parentId)) {
    issues.push({
      path: `${path}.parentId`,
      code: "entity.parent.invalid",
      message: "Entity parentId must be a non-empty string when present",
    });
  } else if (entity.parentId && !sceneEntityIds.has(entity.parentId)) {
    issues.push({
      path: `${path}.parentId`,
      code: "entity.parent.missing",
      message: `Parent entity "${entity.parentId}" does not exist in scene "${scene.id}"`,
    });
  }
}

function validateParentCycles(scene: SceneDefinition, issues: ValidationIssue[]): void {
  const byId = new Map(scene.entities.map((entity) => [entity.id, entity]));
  // Memoised per id so a deep chain is walked once, not once per descendant.
  const verdict = new Map<string, "finite" | "cyclic">();

  /** True when following parentId links from `start` never terminates. */
  const isInfiniteChain = (start: unknown): boolean => {
    const path: string[] = [];
    const onPath = new Set<string>();
    let cursor: unknown = start;
    let cyclic = false;

    while (typeof cursor === "string" && cursor.length > 0) {
      const known = verdict.get(cursor);
      if (known !== undefined) {
        cyclic = known === "cyclic";
        break;
      }
      if (onPath.has(cursor)) {
        cyclic = true;
        break;
      }
      onPath.add(cursor);
      path.push(cursor);
      cursor = byId.get(cursor)?.parentId;
    }

    for (const id of path) verdict.set(id, cyclic ? "cyclic" : "finite");
    return cyclic;
  };

  for (const entity of scene.entities) {
    if (isInfiniteChain(entity.parentId)) {
      issues.push({
        path: `scenes[${scene.id}].entities[${entity.id}].parentId`,
        code: "entity.parent.cycle",
        message: `Parent cycle detected for entity "${entity.id}"`,
      });
    }
  }
}

export function validateProject(project: ProjectDocument): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!isRecord(project)) {
    issues.push({ path: "", code: "project.invalid", message: "Project document must be an object" });
    return issues;
  }

  if (project.schemaVersion !== 1) {
    issues.push({
      path: "schemaVersion",
      code: "project.schema.unsupported",
      message: `Expected schemaVersion 1, received ${String(project.schemaVersion)}`,
    });
  }

  if (!isNonEmptyString(project.projectId)) {
    issues.push({
      path: "projectId",
      code: "project.id.empty",
      message: "Project id is required",
    });
  }

  if (!isNonEmptyString(project.name)) {
    issues.push({ path: "name", code: "project.name.empty", message: "Project name is required" });
  }

  const sceneIds = new Set<string>();
  const entityIds = new Set<string>();

  // Documents arrive from disk/MCP as untrusted JSON: check the container shapes
  // before walking them so malformed input yields structured issues, not TypeErrors.
  const scenes: unknown = project.scenes;
  if (!Array.isArray(scenes)) {
    issues.push({ path: "scenes", code: "project.scenes.invalid", message: "Project scenes must be an array" });
  } else {
    scenes.forEach((rawScene: unknown, sceneIndex) => {
      const scenePath = `scenes[${sceneIndex}]`;

      if (!isRecord(rawScene)) {
        issues.push({ path: scenePath, code: "scene.invalid", message: "Scene must be an object" });
        return;
      }
      const scene = rawScene as unknown as SceneDefinition;

      if (!isNonEmptyString(scene.id)) {
        issues.push({ path: `${scenePath}.id`, code: "scene.id.empty", message: "Scene id is required" });
      } else if (sceneIds.has(scene.id)) {
        issues.push({
          path: `${scenePath}.id`,
          code: "scene.id.duplicate",
          message: `Duplicate scene id "${scene.id}"`,
        });
      }
      sceneIds.add(scene.id);

      if (!isNonEmptyString(scene.name)) {
        issues.push({ path: `${scenePath}.name`, code: "scene.name.empty", message: "Scene name is required" });
      }

      const entities: unknown = scene.entities;
      if (!Array.isArray(entities)) {
        issues.push({
          path: `${scenePath}.entities`,
          code: "scene.entities.invalid",
          message: "Scene entities must be an array",
        });
        return;
      }
      const malformed = entities.findIndex((entity: unknown) => !isRecord(entity));
      if (malformed !== -1) {
        issues.push({
          path: `${scenePath}.entities[${malformed}]`,
          code: "entity.invalid",
          message: "Entity must be an object",
        });
        return;
      }

      // One lookup set per scene keeps parent checks linear instead of O(n²).
      const sceneEntityIds = new Set<unknown>(scene.entities.map((entity) => entity.id));
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
        validateEntity(entity, scene, sceneEntityIds, entityPath, issues);
      });

      validateParentCycles(scene, issues);
    });
  }

  if (project.metadata !== undefined && !(isPlainObject(project.metadata) && isJsonValue(project.metadata))) {
    issues.push({
      path: "metadata",
      code: "project.metadata.not-json",
      message: "Project metadata must be a JSON object with JSON-compatible values only",
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
