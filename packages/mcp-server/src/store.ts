import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  parseProject,
  serializeProject,
  type ProjectDocument,
} from "@kinetra/project-model";

export interface ProjectStore {
  load(): Promise<ProjectDocument>;
  save(project: ProjectDocument): Promise<void>;
}

export class FileProjectStore implements ProjectStore {
  readonly path: string;

  constructor(path: string) {
    this.path = resolve(path);
  }

  async load(): Promise<ProjectDocument> {
    return parseProject(await readFile(this.path, "utf8"));
  }

  async save(project: ProjectDocument): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });

    const temporaryPath = `${this.path}.tmp-${process.pid}`;
    await writeFile(temporaryPath, serializeProject(project), "utf8");
    await rename(temporaryPath, this.path);
  }
}
