import {
  CommandBus,
  type CommandEvent,
  type CommandResult,
  type EngineCommand,
} from "@kinetra/command-bus";
import {
  newId,
  type JsonObject,
  type ProjectDocument,
} from "@kinetra/project-model";

export interface EditorSessionOptions {
  persist?: (project: ProjectDocument) => Promise<void>;
}

export class EditorSession {
  readonly bus: CommandBus;
  readonly #persist: ((project: ProjectDocument) => Promise<void>) | undefined;

  constructor(
    project: ProjectDocument,
    options: EditorSessionOptions = {},
  ) {
    this.bus = new CommandBus(project);
    this.#persist = options.persist;
  }

  snapshot() {
    return this.bus.snapshot();
  }

  events(): CommandEvent[] {
    return this.bus.eventLog();
  }

  async execute(command: EngineCommand): Promise<CommandResult> {
    const result = this.bus.execute(command);

    if (result.revision > 0 && !command.dryRun) {
      await this.#persist?.(this.bus.snapshot().project);
    }

    return result;
  }

  async patchComponent(
    entityId: string,
    component: string,
    patch: JsonObject,
  ): Promise<CommandResult> {
    return this.execute({
      requestId: newId("test"),
      command: "component.patch",
      expectedProjectRevision: this.bus.revision,
      payload: {
        entityId,
        component,
        patch,
      },
    });
  }

  async patchTransform(
    entityId: string,
    transform: {
      position: [number, number, number];
      rotation: [number, number, number];
      scale: [number, number, number];
    },
  ): Promise<CommandResult> {
    return this.patchComponent(entityId, "Transform", transform);
  }

  async createBox(sceneId: string): Promise<CommandResult> {
    return this.execute({
      requestId: newId("test"),
      command: "entity.create",
      expectedProjectRevision: this.bus.revision,
      payload: {
        sceneId,
        entity: {
          id: newId("entity"),
          name: "Box",
          components: {
            Primitive: {
              kind: "box",
              size: [1, 1, 1],
              color: "#d9e6ff",
            },
            Transform: {
              position: [0, 0.5, 0],
              rotation: [0, 0, 0],
              scale: [1, 1, 1],
            },
          },
        },
      },
    });
  }

  async deleteEntity(
    entityId: string,
    cascade = false,
  ): Promise<CommandResult> {
    return this.execute({
      requestId: newId("test"),
      command: "entity.delete",
      expectedProjectRevision: this.bus.revision,
      payload: {
        entityId,
        ...(cascade ? { cascade: true } : {}),
      },
    });
  }
}
