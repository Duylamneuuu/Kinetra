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

const remediationByCode: Record<CommandErrorCode, string> = {
  STALE_REVISION:
    "Call project.inspect, then retry this command with expectedProjectRevision set to the current revision.",
  SCENE_NOT_FOUND:
    "Call scene.query and retry with a scene id that exists.",
  SCENE_ALREADY_EXISTS:
    "Choose a new scene id, or patch the existing scene instead of creating it again.",
  ENTITY_NOT_FOUND:
    "Call entity.query and retry with an entity id that exists.",
  ENTITY_ALREADY_EXISTS:
    "Choose a new entity id, or patch the existing entity instead of creating it again.",
  PARENT_NOT_FOUND:
    "Call entity.query and set parentId to an entity in the same scene, or omit parentId.",
  CHILDREN_EXIST:
    "Reparent or delete child entities before deleting this entity.",
  COMPONENT_NOT_OBJECT:
    "Send the component value as a JSON object of fields to merge.",
  INVALID_COMMAND:
    "Call listEngineCommands() and resend a supported command name with the payload fields it describes.",
};

export class CommandError extends Error {
  readonly code: CommandErrorCode;
  readonly remediation: string;

  constructor(code: CommandErrorCode, message: string, remediation?: string) {
    super(message);
    this.name = "CommandError";
    this.code = code;
    this.remediation = remediation ?? remediationByCode[code];
  }
}
