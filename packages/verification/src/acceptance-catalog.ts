import type { ZodType } from "zod";

import { acceptanceStepSchema } from "./types.js";

export interface AcceptanceOperationField {
  name: string;
  required: boolean;
}

export interface AcceptanceOperation {
  type: string;
  fields: AcceptanceOperationField[];
}

export function listAcceptanceOperations(): AcceptanceOperation[] {
  return acceptanceStepSchema.options
    .map((step) => {
      const type = literalType(step.shape.type);
      const fields = Object.entries(step.shape)
        .filter(([name]) => name !== "type")
        .map(([name, field]) => ({
          name,
          required: field.type !== "optional",
        }))
        .sort((left, right) => left.name.localeCompare(right.name));
      return { type, fields };
    })
    .sort((left, right) => left.type.localeCompare(right.type));
}

function literalType(field: ZodType): string {
  if (field.type !== "literal" || !("values" in field.def) || !Array.isArray(field.def.values)) {
    throw new Error("Acceptance step type must be a literal");
  }
  const value: unknown = field.def.values[0];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Acceptance step type literal is missing");
  }
  return value;
}
