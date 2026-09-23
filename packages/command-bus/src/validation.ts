import type { EntityDefinition, JsonValue, SceneDefinition } from "@kinetra/project-model";

import { supportedCommandNames } from "./catalog.js";
import { CommandError } from "./errors.js";
import type { EngineCommand } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return typeof value !== "number" || Number.isFinite(value);
  }

  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }

  if (isRecord(value)) {
    return Object.values(value).every(isJsonValue);
  }

  return false;
}

function isEntityDefinition(value: unknown): value is EntityDefinition {
  if (!isRecord(value)) {
    return false;
  }

  if (typeof value.id !== "string" || value.id.length === 0) {
    return false;
  }

  if (typeof value.name !== "string" || value.name.length === 0) {
    return false;
  }

  if (value.parentId !== undefined && typeof value.parentId !== "string") {
    return false;
  }

  if (!isRecord(value.components)) {
    return false;
  }

  return Object.values(value.components).every(isJsonValue);
}

function isSceneDefinition(value: unknown): value is SceneDefinition {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.name === "string" &&
    value.name.length > 0 &&
    Array.isArray(value.entities) &&
    value.entities.every(isEntityDefinition)
  );
}

function assertCommonEnvelope(value: Record<string, unknown>): void {
  if (typeof value.requestId !== "string" || value.requestId.length === 0) {
    throw new CommandError("INVALID_COMMAND", "Command requestId must be a non-empty string");
  }

  if (
    value.expectedProjectRevision !== undefined &&
    (!Number.isInteger(value.expectedProjectRevision) ||
      (value.expectedProjectRevision as number) < 0)
  ) {
    throw new CommandError(
      "INVALID_COMMAND",
      "expectedProjectRevision must be a non-negative integer",
    );
  }

  if (value.transactionId !== undefined && typeof value.transactionId !== "string") {
    throw new CommandError("INVALID_COMMAND", "transactionId must be a string when provided");
  }

  if (value.dryRun !== undefined && typeof value.dryRun !== "boolean") {
    throw new CommandError("INVALID_COMMAND", "dryRun must be a boolean when provided");
  }
}

function assertJsonObject(value: unknown, message: string): asserts value is Record<string, JsonValue> {
  if (!isRecord(value) || !Object.values(value).every(isJsonValue)) {
    throw new CommandError("INVALID_COMMAND", message);
  }
}

export function parseEngineCommand(input: unknown): EngineCommand {
  if (!isRecord(input)) {
    throw new CommandError("INVALID_COMMAND", "Command must be an object");
  }

  assertCommonEnvelope(input);

  if (typeof input.command !== "string") {
    throw new CommandError("INVALID_COMMAND", "Command name must be a string");
  }

  if (!isRecord(input.payload)) {
    throw new CommandError("INVALID_COMMAND", "Command payload must be an object");
  }

  const payload = input.payload;

  switch (input.command) {
    case "scene.create": {
      if (!isSceneDefinition(payload.scene)) {
        throw new CommandError("INVALID_COMMAND", "scene.create payload.scene is invalid");
      }
      break;
    }

    case "entity.create": {
      if (typeof payload.sceneId !== "string" || !isEntityDefinition(payload.entity)) {
        throw new CommandError(
          "INVALID_COMMAND",
          "entity.create requires a string sceneId and valid entity",
        );
      }
      break;
    }

    case "component.patch": {
      if (
        typeof payload.entityId !== "string" ||
        typeof payload.component !== "string" ||
        payload.component.length === 0
      ) {
        throw new CommandError(
          "INVALID_COMMAND",
          "component.patch requires entityId and non-empty component strings",
        );
      }
      assertJsonObject(payload.patch, "component.patch payload.patch must contain JSON data");
      break;
    }

    case "entity.reparent": {
      if (
        typeof payload.entityId !== "string" ||
        (payload.parentId !== undefined && typeof payload.parentId !== "string")
      ) {
        throw new CommandError(
          "INVALID_COMMAND",
          "entity.reparent requires entityId and an optional string parentId",
        );
      }
      break;
    }

    case "entity.delete": {
      if (
        typeof payload.entityId !== "string" ||
        (payload.cascade !== undefined && typeof payload.cascade !== "boolean")
      ) {
        throw new CommandError(
          "INVALID_COMMAND",
          "entity.delete requires entityId and an optional boolean cascade",
        );
      }
      break;
    }

    default:
      throw new CommandError(
        "INVALID_COMMAND",
        `Unsupported command "${input.command}"`,
        `Use one of: ${supportedCommandNames()}.`,
      );
  }

  return structuredClone(input) as unknown as EngineCommand;
}
