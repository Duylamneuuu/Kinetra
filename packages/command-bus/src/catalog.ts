export interface EngineCommandField {
  name: string;
  required: boolean;
  value: string;
}

export interface EngineCommandDescriptor {
  name: string;
  summary: string;
  payload: EngineCommandField[];
}

export interface EngineCommandCatalog {
  schemaVersion: 1;
  envelope: EngineCommandField[];
  commands: EngineCommandDescriptor[];
}

const envelope: readonly EngineCommandField[] = [
  { name: "requestId", required: true, value: "non-empty string" },
  { name: "expectedProjectRevision", required: false, value: "non-negative integer" },
  { name: "transactionId", required: false, value: "string" },
  { name: "dryRun", required: false, value: "boolean" },
];

const commands: readonly EngineCommandDescriptor[] = [
  {
    name: "component.patch",
    summary: "Merge a JSON object into one component on an existing entity.",
    payload: [
      { name: "entityId", required: true, value: "string" },
      { name: "component", required: true, value: "non-empty string" },
      { name: "patch", required: true, value: "JSON object" },
    ],
  },
  {
    name: "entity.create",
    summary: "Add an entity to a scene.",
    payload: [
      { name: "sceneId", required: true, value: "string" },
      {
        name: "entity",
        required: true,
        value: "entity with id, name, components, and optional parentId",
      },
    ],
  },
  {
    name: "entity.delete",
    summary: "Delete an entity. Children block deletion unless cascade is true.",
    payload: [
      { name: "entityId", required: true, value: "string" },
      { name: "cascade", required: false, value: "boolean" },
    ],
  },
  {
    name: "entity.reparent",
    summary: "Move an entity under another entity in the same scene, or to the scene root.",
    payload: [
      { name: "entityId", required: true, value: "string" },
      { name: "parentId", required: false, value: "string" },
    ],
  },
  {
    name: "scene.create",
    summary: "Add a scene and its entities.",
    payload: [
      {
        name: "scene",
        required: true,
        value: "scene with id, name, and an entities array",
      },
    ],
  },
];

function cloneField(field: EngineCommandField): EngineCommandField {
  return { name: field.name, required: field.required, value: field.value };
}

/** Read-only description of the typed authoring commands. */
export function listEngineCommands(): EngineCommandCatalog {
  return {
    schemaVersion: 1,
    envelope: envelope.map(cloneField),
    commands: commands.map((command) => ({
      name: command.name,
      summary: command.summary,
      payload: command.payload.map(cloneField),
    })),
  };
}

export function supportedCommandNames(): string {
  return commands.map((command) => command.name).join(", ");
}
