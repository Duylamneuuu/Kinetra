import type { ProjectDocument } from "./types.js";

export function cloneProject(project: ProjectDocument): ProjectDocument {
  return structuredClone(project);
}
