export type CommandErrorCode =
  | "STALE_REVISION"
  | "SCENE_NOT_FOUND"
  | "SCENE_ALREADY_EXISTS"
  | "ENTITY_NOT_FOUND"
  | "ENTITY_ALREADY_EXISTS"
  | "PARENT_NOT_FOUND"
  | "CHILDREN_EXIST"
  | "COMPONENT_NOT_OBJECT"
  | "INVALID_COMMAND";

export class CommandError extends Error {
  readonly code: CommandErrorCode;

  constructor(code: CommandErrorCode, message: string) {
    super(message);
    this.name = "CommandError";
    this.code = code;
  }
}
