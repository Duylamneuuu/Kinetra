import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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

let temporaryCounter = 0;

export class FileProjectStore implements ProjectStore {
  readonly path: string;
  /** Tail of the save chain: saves run strictly one after another, in call order. */
  #queue: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.path = resolve(path);
  }

  async load(): Promise<ProjectDocument> {
    return parseProject(await readFile(this.path, "utf8"));
  }

  /**
   * Atomically persists the project. Concurrent calls (overlapping MCP tool calls) are
   * serialized so the snapshot passed last always ends up on disk, and each write uses
   * its own temporary file so overlapping writes can never rename each other's file.
   * The document is serialized synchronously at call time, so later in-memory mutations
   * cannot leak into an earlier save.
   */
  save(project: ProjectDocument): Promise<void> {
    let text: string;
    try {
      text = serializeProject(project);
    } catch (error) {
      return Promise.reject(error);
    }
    const run = this.#queue.then(() => this.#write(text));
    // Keep the chain alive after a failed write; the failure is still reported to this caller.
    this.#queue = run.catch(() => {});
    return run;
  }

  async #write(text: string): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    temporaryCounter += 1;
    const temporaryPath = `${this.path}.tmp-${process.pid}-${temporaryCounter}`;
    try {
      await writeFile(temporaryPath, text, "utf8");
      await rename(temporaryPath, this.path);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => {});
      throw error;
    }
  }
}
