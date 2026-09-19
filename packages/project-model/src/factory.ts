import { newId } from "./id.js";
import type { ProjectDocument, SceneDefinition } from "./types.js";

export interface CreateProjectOptions {
  name: string;
  projectId?: string;
}

export function createProject(options: CreateProjectOptions): ProjectDocument {
  return {
    schemaVersion: 1,
    projectId: options.projectId ?? newId("project"),
    name: options.name,
    scenes: [],
  };
}

export function createScene(name: string, sceneId = newId("scene")): SceneDefinition {
  return {
    id: sceneId,
    name,
    entities: [],
  };
}
