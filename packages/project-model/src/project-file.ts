import { migrateProject } from "./migration.js";
import { ProjectValidationError, type ValidationIssue } from "./validation.js";

export interface ProjectFileSceneSummary {
  id: string;
  name: string;
  entityCount: number;
}

export interface ProjectFileReport {
  ok: true;
  projectId: string;
  name: string;
  schemaVersion: number;
  scenes: ProjectFileSceneSummary[];
}

export interface ProjectFileFailure {
  ok: false;
  message: string;
  issues?: ValidationIssue[];
}

export function reportProjectText(text: string): ProjectFileReport | ProjectFileFailure {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  try {
    const project = migrateProject(parsed);
    return {
      ok: true,
      projectId: project.projectId,
      name: project.name,
      schemaVersion: project.schemaVersion,
      scenes: project.scenes.map((scene) => ({
        id: scene.id,
        name: scene.name,
        entityCount: scene.entities.length,
      })),
    };
  } catch (error) {
    if (error instanceof ProjectValidationError) {
      return {
        ok: false,
        message: error.message,
        issues: error.issues,
      };
    }
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
