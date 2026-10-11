import {
  CAMERA_TYPES,
  LIGHT_KINDS,
  PRIMITIVE_KINDS,
  SCHEMATISED_COMPONENTS,
  validateBuiltInComponent,
  type ComponentIssue,
  type EntityDefinition,
  type JsonValue,
} from "@kinetra/project-model";

/**
 * Inspector model: a pure, deterministic description of what the observer editor's property panel
 * shows for one entity. It never touches the bus and never keeps a copy of the project; it only
 * reshapes an `EntityDefinition` snapshot plus descriptive field schemas into rows. Edits still go
 * through `EditorSession.setProperty` (the command bus).
 *
 * The descriptors are *presentation* metadata (kind, bounds, options). Validation stays owned by
 * `@kinetra/project-model` (`validateBuiltInComponent`); the built-in descriptors are pinned to it
 * by a consistency test so the two cannot drift silently.
 */
export type InspectorFieldKind = "number" | "string" | "boolean" | "enum" | "vector3" | "color" | "json";

export interface InspectorFieldSchema {
  name: string;
  kind: InspectorFieldKind;
  label?: string;
  /** Inclusive bounds (number) or per-component bounds (vector3). */
  min?: number;
  max?: number;
  exclusiveMin?: number;
  exclusiveMax?: number;
  /** Allowed values for `enum`. */
  options?: readonly string[];
  /** Value the runtime uses when the field is omitted, only when that is known for certain. */
  default?: JsonValue;
}

export interface InspectorComponentSchema {
  name: string;
  fields: readonly InspectorFieldSchema[];
}

export interface InspectorRow {
  /** Field name inside the component (top-level key). */
  path: string;
  label: string;
  kind: InspectorFieldKind;
  /** Current value (a copy); undefined when the field is not set on the entity. */
  value: JsonValue | undefined;
  /** True when the entity actually carries the field. */
  present: boolean;
  default?: JsonValue;
  min?: number;
  max?: number;
  exclusiveMin?: number;
  exclusiveMax?: number;
  options?: readonly string[];
  /** The field is not described by any schema (free-form data), shown raw. */
  unknown: boolean;
  /** Structured validation issue for this field, when the built-in schema rejects the value. */
  issue?: ComponentIssue;
}

export interface InspectorSection {
  component: string;
  /** False when no descriptor exists for this component: rows are raw, flagged `unknown`. */
  known: boolean;
  rows: InspectorRow[];
  /** Issues not tied to a single field (component not an object, cross-field rules). */
  issues: ComponentIssue[];
  /** Copy of the raw component value when it is not an object (so nothing is hidden). */
  raw?: JsonValue;
}

export interface InspectorModel {
  entityId: string;
  name: string;
  parentId?: string;
  sections: InspectorSection[];
}

const vector = (name: string, extra: Partial<InspectorFieldSchema> = {}): InspectorFieldSchema => ({
  name,
  kind: "vector3",
  ...extra,
});

/** Descriptors for the built-in components the engine interprets (mirrors project-model's schemas). */
export const BUILT_IN_INSPECTOR_SCHEMAS: readonly InspectorComponentSchema[] = [
  {
    name: "Transform",
    fields: [
      vector("position", { default: [0, 0, 0] }),
      vector("rotation", { default: [0, 0, 0] }),
      vector("scale", { default: [1, 1, 1] }),
    ],
  },
  {
    name: "Primitive",
    fields: [
      { name: "kind", kind: "enum", options: PRIMITIVE_KINDS },
      { name: "color", kind: "color" },
      { name: "roughness", kind: "number", min: 0, max: 1 },
      { name: "metalness", kind: "number", min: 0, max: 1 },
      vector("size", { min: 0 }),
      { name: "radius", kind: "number", exclusiveMin: 0 },
      { name: "segments", kind: "number", min: 1 },
      { name: "width", kind: "number", exclusiveMin: 0 },
      { name: "height", kind: "number", exclusiveMin: 0 },
    ],
  },
  {
    name: "Camera",
    fields: [
      { name: "type", kind: "enum", options: CAMERA_TYPES },
      { name: "fov", kind: "number", exclusiveMin: 0, exclusiveMax: 180 },
      { name: "aspect", kind: "number", exclusiveMin: 0 },
      { name: "near", kind: "number", exclusiveMin: 0, default: 0.1 },
      { name: "far", kind: "number", exclusiveMin: 0, default: 2000 },
    ],
  },
  {
    name: "Light",
    fields: [
      { name: "kind", kind: "enum", options: LIGHT_KINDS },
      { name: "color", kind: "color" },
      { name: "intensity", kind: "number", min: 0 },
    ],
  },
  { name: "Model", fields: [{ name: "assetId", kind: "string" }] },
  {
    name: "Script",
    fields: [
      { name: "scriptId", kind: "string" },
      { name: "order", kind: "number" },
    ],
  },
];

/** Names that have an inspector descriptor but no project-model schema, or vice versa (for tests). */
export function inspectorSchemaDrift(schemas: readonly InspectorComponentSchema[] = BUILT_IN_INSPECTOR_SCHEMAS): string[] {
  const described = new Set(schemas.map((schema) => schema.name));
  return [
    ...SCHEMATISED_COMPONENTS.filter((name) => !described.has(name)).map((name) => `missing descriptor: ${name}`),
    ...[...described].filter((name) => !SCHEMATISED_COMPONENTS.includes(name)).map((name) => `no schema: ${name}`),
  ];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(target: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, key);
}

function safeClone(value: unknown): JsonValue | undefined {
  try {
    return structuredClone(value) as JsonValue;
  } catch {
    return undefined;
  }
}

function inferKind(value: unknown): InspectorFieldKind {
  switch (typeof value) {
    case "number":
      return "number";
    case "string":
      return "string";
    case "boolean":
      return "boolean";
    default:
      return "json";
  }
}

function safeValidate(name: string, value: unknown): ComponentIssue[] {
  try {
    return validateBuiltInComponent(name, value);
  } catch {
    // validateBuiltInComponent promises not to throw; if it ever does, the inspector must not.
    return [];
  }
}

function describeField(schema: InspectorFieldSchema, record: Record<string, unknown> | undefined, issue: ComponentIssue | undefined): InspectorRow {
  const present = record !== undefined && hasOwn(record, schema.name) && record[schema.name] !== undefined;
  const row: InspectorRow = {
    path: schema.name,
    label: schema.label ?? schema.name,
    kind: schema.kind,
    value: present ? safeClone((record as Record<string, unknown>)[schema.name]) : undefined,
    present,
    unknown: false,
  };
  if (schema.default !== undefined) row.default = structuredClone(schema.default);
  if (schema.min !== undefined) row.min = schema.min;
  if (schema.max !== undefined) row.max = schema.max;
  if (schema.exclusiveMin !== undefined) row.exclusiveMin = schema.exclusiveMin;
  if (schema.exclusiveMax !== undefined) row.exclusiveMax = schema.exclusiveMax;
  if (schema.options !== undefined) row.options = [...schema.options];
  if (issue) row.issue = issue;
  return row;
}

function describeComponent(
  name: string,
  value: unknown,
  schema: InspectorComponentSchema | undefined,
): InspectorSection {
  const validated = SCHEMATISED_COMPONENTS.includes(name) ? safeValidate(name, value) : [];

  if (!isObject(value)) {
    // Nothing to edit row-by-row; keep the raw value visible rather than dropping the component.
    const raw = safeClone(value);
    return {
      component: name,
      known: schema !== undefined,
      rows: [],
      issues: validated,
      ...(raw !== undefined ? { raw } : {}),
    };
  }

  const issuesByField = new Map<string, ComponentIssue>();
  const unattached: ComponentIssue[] = [];
  for (const issue of validated) {
    if (issue.field !== "" && !issuesByField.has(issue.field)) {
      issuesByField.set(issue.field, issue);
    } else {
      unattached.push(issue);
    }
  }

  const rows: InspectorRow[] = [];
  const described = new Set<string>();
  for (const field of schema?.fields ?? []) {
    described.add(field.name);
    rows.push(describeField(field, value, issuesByField.get(field.name)));
  }
  // Fields the schema does not describe stay visible, raw and flagged: scripts attach their own.
  for (const key of Object.keys(value)) {
    if (described.has(key) || value[key] === undefined) continue;
    rows.push({
      path: key,
      label: key,
      kind: inferKind(value[key]),
      value: safeClone(value[key]),
      present: true,
      unknown: true,
    });
  }

  return { component: name, known: schema !== undefined, rows, issues: unattached };
}

/**
 * Builds the inspector rows for one entity. Pure and total: any JSON-ish component payload
 * (NaN, null, deeply nested arrays, non-object components) yields a model and never throws.
 * Components without a descriptor are shown raw with every row flagged `unknown`.
 */
export function buildInspector(
  entity: EntityDefinition,
  schemas: readonly InspectorComponentSchema[] = BUILT_IN_INSPECTOR_SCHEMAS,
): InspectorModel {
  const byName = new Map<string, InspectorComponentSchema>();
  for (const schema of schemas) {
    if (!byName.has(schema.name)) byName.set(schema.name, schema);
  }
  const components: Record<string, unknown> = isObject(entity.components) ? entity.components : {};
  const sections = Object.keys(components).map((name) => describeComponent(name, components[name], byName.get(name)));
  return {
    entityId: entity.id,
    name: entity.name,
    ...(entity.parentId !== undefined ? { parentId: entity.parentId } : {}),
    sections,
  };
}

/** Path to a (possibly nested) property inside a component: "fov", "position.1", or ["position", 1]. */
export type PropertyPath = string | ReadonlyArray<string | number>;

export function normalizePropertyPath(path: PropertyPath): Array<string | number> | undefined {
  const parts: Array<string | number> =
    typeof path === "string" ? (path === "" ? [] : path.split(".")) : [...path];
  if (parts.length === 0) return undefined;
  for (const part of parts) {
    if (typeof part === "number") {
      if (!Number.isSafeInteger(part) || part < 0) return undefined;
    } else if (typeof part !== "string" || part === "" || part === "__proto__") {
      return undefined;
    }
  }
  return parts;
}

function isArrayIndex(part: string | number): boolean {
  return typeof part === "number" || /^(0|[1-9]\d*)$/.test(part);
}

/**
 * Returns a copy of `container` (a component's top-level field value) with `value` written at the
 * rest of `parts`. Arrays are indexed by integer segments; objects by key. Returns undefined when
 * the path steps through a scalar or an out-of-range array index, so the caller can report it.
 */
export function setAtPath(
  container: JsonValue | undefined,
  parts: ReadonlyArray<string | number>,
  value: JsonValue,
): JsonValue | undefined {
  if (parts.length === 0) return structuredClone(value);
  const [head, ...rest] = parts as [string | number, ...Array<string | number>];
  if (Array.isArray(container)) {
    if (!isArrayIndex(head)) return undefined;
    const index = Number(head);
    if (index > container.length) return undefined;
    const child = setAtPath(container[index], rest, value);
    if (child === undefined) return undefined;
    const copy = structuredClone(container);
    copy[index] = child;
    return copy;
  }
  if (isObject(container)) {
    const key = String(head);
    const child = setAtPath(hasOwn(container, key) ? (container[key] as JsonValue) : undefined, rest, value);
    if (child === undefined) return undefined;
    const copy = structuredClone(container) as Record<string, JsonValue>;
    Object.defineProperty(copy, key, { value: child, enumerable: true, writable: true, configurable: true });
    return copy;
  }
  if (container === undefined && rest.length === 0) {
    // Creating a brand-new leaf directly on a missing object.
    return { [String(head)]: structuredClone(value) };
  }
  if (container === undefined) {
    const child = setAtPath(undefined, rest, value);
    return child === undefined ? undefined : { [String(head)]: child };
  }
  return undefined;
}
