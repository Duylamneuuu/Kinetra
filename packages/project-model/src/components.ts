import type { JsonValue } from "./types.js";

/**
 * Schemas for the built-in components the engine itself interprets
 * (`Transform`, `Primitive`, `Camera`, `Light`, `Model`, `Script`, `Collider`,
 * `RigidBody`, `CharacterBody`, `NavMesh`).
 *
 * The runtime is deliberately forgiving (a malformed `Transform` falls back to
 * defaults, a bad `Primitive.kind` throws at instantiate time). That is the wrong
 * place to discover an authoring mistake, so the same rules are enforced at the
 * authoring boundary and reported as structured issues with a remediation.
 *
 * Rules:
 * - Only the *known* fields of a built-in component are checked; unknown fields
 *   stay free-form so scripts and tools can attach their own data.
 * - Components whose name is not listed here (custom or not-yet-schematised, e.g.
 *   `Health`, `Inventory`) are never inspected.
 * - Every field is optional, matching the runtime defaults.
 */
export interface ComponentIssue {
  /** Path relative to the component, e.g. "" for the component itself or "position". */
  field: string;
  code: string;
  message: string;
  remediation: string;
}

type FieldCheck = (value: JsonValue) => string | undefined;

interface ComponentSchema {
  fields: Record<string, FieldCheck>;
  /** Cross-field checks run only when every individual field passed. */
  relations?: (value: Record<string, JsonValue>) => ComponentIssue[];
}

export const PRIMITIVE_KINDS = ["box", "sphere", "plane"] as const;
export const LIGHT_KINDS = ["ambient", "point", "directional"] as const;
export const CAMERA_TYPES = ["perspective"] as const;

function isObject(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function vec3(options: { min?: number; exclusiveMin?: number } = {}): FieldCheck {
  return (value) => {
    if (!Array.isArray(value) || value.length !== 3) {
      return "must be an array of exactly three finite numbers [x, y, z]";
    }
    for (const entry of value) {
      if (typeof entry !== "number" || !Number.isFinite(entry)) {
        return "must contain only finite numbers";
      }
      if (options.min !== undefined && entry < options.min) {
        return `components must be >= ${options.min}`;
      }
      if (options.exclusiveMin !== undefined && entry <= options.exclusiveMin) {
        return `components must be > ${options.exclusiveMin}`;
      }
    }
    return undefined;
  };
}

function finiteNumber(
  options: { min?: number; exclusiveMin?: number; max?: number; exclusiveMax?: number } = {},
): FieldCheck {
  return (value) => {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return "must be a finite number";
    }
    if (options.min !== undefined && value < options.min) return `must be >= ${options.min}`;
    if (options.exclusiveMin !== undefined && value <= options.exclusiveMin) {
      return `must be > ${options.exclusiveMin}`;
    }
    if (options.max !== undefined && value > options.max) return `must be <= ${options.max}`;
    if (options.exclusiveMax !== undefined && value >= options.exclusiveMax) {
      return `must be < ${options.exclusiveMax}`;
    }
    return undefined;
  };
}

function oneOf(allowed: readonly string[]): FieldCheck {
  return (value) =>
    typeof value === "string" && allowed.includes(value)
      ? undefined
      : `must be one of ${allowed.map((entry) => `"${entry}"`).join(", ")}`;
}

function nonEmptyString(): FieldCheck {
  return (value) =>
    typeof value === "string" && value.length > 0 ? undefined : "must be a non-empty string";
}

/** Like `oneOf`, but case-insensitive: the physics factory lower-cases `RigidBody.type`. */
function oneOfIgnoringCase(allowed: readonly string[]): FieldCheck {
  const lowered = allowed.map((entry) => entry.toLowerCase());
  return (value) =>
    typeof value === "string" && lowered.includes(value.toLowerCase())
      ? undefined
      : `must be one of ${allowed.map((entry) => `"${entry}"`).join(", ")} (case-insensitive)`;
}

/** Integer in `[min, max]`. */
function integerInRange(min: number, max: number): FieldCheck {
  return (value) =>
    typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
      ? undefined
      : `must be an integer between ${min} and ${max}`;
}

/** Array of finite numbers whose length is a multiple of `stride` (empty arrays are accepted). */
function numberArray(stride: number): FieldCheck {
  return (value) => {
    if (!Array.isArray(value)) return "must be an array of finite numbers";
    if (value.length % stride !== 0) {
      return `must have a length that is a multiple of ${stride} (got ${value.length})`;
    }
    for (let i = 0; i < value.length; i++) {
      const entry = value[i];
      if (typeof entry !== "number" || !Number.isFinite(entry)) {
        return `must contain only finite numbers (entry ${i} is not)`;
      }
    }
    return undefined;
  };
}

/** Array of non-negative integers whose length is a multiple of `stride`. */
function indexArray(stride: number): FieldCheck {
  return (value) => {
    if (!Array.isArray(value)) return "must be an array of non-negative integers";
    if (value.length % stride !== 0) {
      return `must have a length that is a multiple of ${stride} (got ${value.length})`;
    }
    for (let i = 0; i < value.length; i++) {
      const entry = value[i];
      if (typeof entry !== "number" || !Number.isInteger(entry) || entry < 0) {
        return `must contain only non-negative integers (entry ${i} is not)`;
      }
    }
    return undefined;
  };
}

function plainObject(): FieldCheck {
  return (value) => (isObject(value) ? undefined : "must be a JSON object");
}

export const RIGID_BODY_TYPES = [
  "fixed",
  "static",
  "dynamic",
  "kinematic",
  "kinematicPositionBased",
  "kinematicVelocityBased",
] as const;

/** Highest query-filter layer a `Collider.layer` may use (mirrors `MAX_PHYSICS_LAYER`). */
export const MAX_COLLIDER_LAYER = 31;

/** CSS-style colour string accepted by `THREE.Color` (name, #rgb/#rrggbb, rgb()/hsl()). */
function colorString(): FieldCheck {
  return (value) =>
    typeof value === "string" && value.trim().length > 0
      ? undefined
      : "must be a non-empty colour string such as \"#ff8800\"";
}

const schemas: Record<string, ComponentSchema> = {
  Transform: {
    fields: {
      position: vec3(),
      rotation: vec3(),
      scale: vec3(),
    },
  },
  Primitive: {
    fields: {
      kind: oneOf(PRIMITIVE_KINDS),
      color: colorString(),
      roughness: finiteNumber({ min: 0, max: 1 }),
      metalness: finiteNumber({ min: 0, max: 1 }),
      size: vec3({ min: 0 }),
      radius: finiteNumber({ exclusiveMin: 0 }),
      segments: finiteNumber({ min: 1 }),
      width: finiteNumber({ exclusiveMin: 0 }),
      height: finiteNumber({ exclusiveMin: 0 }),
    },
  },
  Camera: {
    fields: {
      type: oneOf(CAMERA_TYPES),
      fov: finiteNumber({ exclusiveMin: 0, exclusiveMax: 180 }),
      aspect: finiteNumber({ exclusiveMin: 0 }),
      near: finiteNumber({ exclusiveMin: 0 }),
      far: finiteNumber({ exclusiveMin: 0 }),
    },
    relations: (value) => {
      const near = typeof value.near === "number" ? value.near : 0.1;
      const far = typeof value.far === "number" ? value.far : 2000;
      return far > near
        ? []
        : [
            {
              field: "far",
              code: "component.Camera.far.invalid",
              message: `Camera.far (${far}) must be greater than Camera.near (${near})`,
              remediation: "Set Camera.far larger than Camera.near, or omit both to use 0.1 and 2000.",
            },
          ];
    },
  },
  Light: {
    fields: {
      kind: oneOf(LIGHT_KINDS),
      color: colorString(),
      intensity: finiteNumber({ min: 0 }),
    },
  },
  Model: {
    fields: {
      assetId: nonEmptyString(),
    },
  },
  Script: {
    fields: {
      scriptId: nonEmptyString(),
      order: finiteNumber(),
    },
  },
  Collider: {
    fields: {
      shape: nonEmptyString(),
      size: vec3({ min: 0 }),
      halfExtents: vec3({ min: 0 }),
      radius: finiteNumber({ exclusiveMin: 0 }),
      halfHeight: finiteNumber({ min: 0 }),
      friction: finiteNumber({ min: 0 }),
      restitution: finiteNumber({ min: 0 }),
      layer: integerInRange(0, MAX_COLLIDER_LAYER),
    },
  },
  RigidBody: {
    fields: {
      type: oneOfIgnoringCase(RIGID_BODY_TYPES),
      mass: finiteNumber({ exclusiveMin: 0 }),
      gravityScale: finiteNumber(),
      linearDamping: finiteNumber({ min: 0 }),
      angularDamping: finiteNumber({ min: 0 }),
    },
  },
  CharacterBody: {
    fields: {
      speed: finiteNumber({ min: 0 }),
      offset: finiteNumber({ min: 0 }),
      autostepMaxHeight: finiteNumber({ min: 0 }),
      autostepMinWidth: finiteNumber({ min: 0 }),
    },
  },
  NavMesh: {
    fields: {
      dataBase64: nonEmptyString(),
      positions: numberArray(3),
      indices: indexArray(3),
      config: plainObject(),
    },
    relations: (value) => {
      const { positions, indices } = value;
      if (!Array.isArray(positions) || !Array.isArray(indices)) return [];
      const vertexCount = positions.length / 3;
      for (let i = 0; i < indices.length; i++) {
        if ((indices[i] as number) >= vertexCount) {
          return [
            {
              field: "indices",
              code: "component.NavMesh.indices.outOfRange",
              message: `NavMesh.indices[${i}] (${String(indices[i])}) refers to a vertex that does not exist; positions holds ${vertexCount} vertices`,
              remediation:
                "Make every index smaller than positions.length / 3, or add the missing vertices to NavMesh.positions.",
            },
          ];
        }
      }
      return [];
    },
  },
};

/** Names of the built-in components that have a schema. */
export const SCHEMATISED_COMPONENTS: readonly string[] = Object.keys(schemas);

const remediationHints: Record<string, Record<string, string>> = {
  Primitive: {
    kind: `Use one of ${PRIMITIVE_KINDS.join(", ")}.`,
  },
  Light: {
    kind: `Use one of ${LIGHT_KINDS.join(", ")}.`,
  },
  Camera: {
    type: `Use one of ${CAMERA_TYPES.join(", ")}.`,
  },
};

function hasOwn(target: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, key);
}

/**
 * Validates one built-in component value. Returns an empty array for components
 * without a schema. Never throws, even on non-JSON input.
 */
export function validateBuiltInComponent(name: string, value: unknown): ComponentIssue[] {
  if (!hasOwn(schemas, name)) {
    return [];
  }
  const schema = schemas[name] as ComponentSchema;

  if (!isObject(value as JsonValue)) {
    return [
      {
        field: "",
        code: `component.${name}.invalid`,
        message: `Component "${name}" must be a JSON object`,
        remediation: `Send ${name} as an object of fields, for example {} to use the defaults.`,
      },
    ];
  }

  const record = value as Record<string, JsonValue>;
  const issues: ComponentIssue[] = [];

  for (const [field, check] of Object.entries(schema.fields)) {
    if (!hasOwn(record, field) || record[field] === undefined) {
      continue;
    }
    const problem = check(record[field] as JsonValue);
    if (problem) {
      issues.push({
        field,
        code: `component.${name}.${field}.invalid`,
        message: `${name}.${field} ${problem}`,
        remediation:
          remediationHints[name]?.[field] ??
          `Fix ${name}.${field} (${problem}), or remove the field to use the default.`,
      });
    }
  }

  if (issues.length === 0 && schema.relations) {
    issues.push(...schema.relations(record));
  }

  return issues;
}
