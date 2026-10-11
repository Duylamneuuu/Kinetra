import type { ProjectDocument } from "./types.js";
import { MAX_JSON_DEPTH, ProjectValidationError } from "./validation.js";

/**
 * Deep copy of a project document.
 *
 * Precondition: `project` should already have passed `validateProject`/`assertValidProject`,
 * which bounds JSON nesting at `MAX_JSON_DEPTH`. An unvalidated document nested deeply enough to
 * exhaust the stack (tens of thousands of levels) makes `structuredClone` throw a raw
 * `RangeError`; that case is reported as a structured `ProjectValidationError`
 * (`project.json.too-deep`, original error as `cause`) instead.
 */
export function cloneProject(project: ProjectDocument): ProjectDocument {
  try {
    return structuredClone(project);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    const tooDeep = new ProjectValidationError([
      {
        path: "",
        code: "project.json.too-deep",
        message: `Project document is nested too deeply to copy (${error.message}); validated documents allow at most ${MAX_JSON_DEPTH} nested JSON containers`,
      },
    ]);
    Object.defineProperty(tooDeep, "cause", { value: error, enumerable: false, writable: true, configurable: true });
    throw tooDeep;
  }
}
