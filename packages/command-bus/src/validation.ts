import type { EntityDefinition, JsonValue, SceneDefinition } from "@kinetra/project-model";

import { CommandError } from "./errors.js";
import type { EngineCommand } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Component data nested deeper than this is rejected. It also stops cyclic
 * input: without a bound, `a.self = a` (or a very deep literal) overflowed the
 * stack and surfaced as a raw RangeError instead of a structured CommandError.
 */
const MAX_JSON_DEPTH = 128;

function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return typeof value !== "number" || Number.isFinite(value);
  }

  if (depth >= MAX_JSON_DEPTH) {
    return false;
  }

  if (Array.isArray(value)) {
    return value.every((item) => isJsonValue(item, depth + 1));
  }

  if (isRecord(value)) {
    return Object.values(value).every((item) => isJsonValue(item, depth + 1));
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

  return Object.values(value.components).every((item) => isJsonValue(item));
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
  if (!isRecord(value) || !Object.values(value).every((item) => isJsonValue(item))) {
    throw new CommandError("INVALID_COMMAND", message);
  }
}

function parseCommandRecord(input: unknown): EngineCommand {
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

    case "component.remove": {
      if (
        typeof payload.entityId !== "string" ||
        typeof payload.component !== "string" ||
        payload.component.length === 0
      ) {
        throw new CommandError(
          "INVALID_COMMAND",
          "component.remove requires entityId and non-empty component strings",
        );
      }
      break;
    }

    case "component.unsetFields": {
      if (
        typeof payload.entityId !== "string" ||
        typeof payload.component !== "string" ||
        payload.component.length === 0 ||
        !Array.isArray(payload.fields) ||
        payload.fields.length === 0 ||
        !payload.fields.every((field) => typeof field === "string" && field.length > 0)
      ) {
        throw new CommandError(
          "INVALID_COMMAND",
          "component.unsetFields requires entityId, a non-empty component string and a non-empty array of non-empty field name strings",
        );
      }
      break;
    }

    case "entity.reparent": {
      if (
        typeof payload.entityId !== "string" ||
        (payload.parentId !== undefined &&
          (typeof payload.parentId !== "string" || payload.parentId.length === 0))
      ) {
        // An empty parentId used to be falsy in the handler and silently detach the entity;
        // detaching is spelled by omitting parentId, never by a blank string.
        throw new CommandError(
          "INVALID_COMMAND",
          "entity.reparent requires entityId and an optional non-empty string parentId (omit parentId to detach)",
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
      throw new CommandError("INVALID_COMMAND", `Unsupported command "${input.command}"`);
  }

  return structuredClone(input) as unknown as EngineCommand;
}

/**
 * Validates untrusted input and returns a deep, detached copy of it as a typed command.
 * Every failure is a structured `INVALID_COMMAND`: besides the shape checks, input a caller
 * built in-process can hold values that cannot be read or cloned (functions or symbols in an
 * envelope field, a throwing getter, a revoked proxy), which used to escape as a raw
 * DOMException or Error instead of a `CommandError`.
 */
export function parseEngineCommand(input: unknown): EngineCommand {
  try {
    return parseCommandRecord(input);
  } catch (error) {
    if (error instanceof CommandError) {
      throw error;
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw new CommandError(
      "INVALID_COMMAND",
      `Command could not be read as plain JSON data: ${reason}`,
    );
  }
}
