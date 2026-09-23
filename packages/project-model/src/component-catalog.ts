export interface RuntimeComponentField {
  name: string;
  required: boolean;
  value: string;
}

export interface RuntimeComponentDescriptor {
  name: string;
  summary: string;
  fields: RuntimeComponentField[];
}

export interface RuntimeComponentCatalog {
  schemaVersion: 1;
  components: RuntimeComponentDescriptor[];
}

/**
 * Components the player runtime interprets. Other component names stay valid
 * project JSON; this catalog does not reject them.
 *
 * Field notes match the current readers in the Three.js projection, Rapier
 * scene factory, and player runtime (NavMesh, Script).
 */
const components: readonly RuntimeComponentDescriptor[] = [
  {
    name: "Camera",
    summary: "Perspective camera. Other type values are rejected at projection time.",
    fields: [
      { name: "type", required: false, value: 'string, default "perspective"; only "perspective" is supported' },
      { name: "fov", required: false, value: "finite number, default 60" },
      { name: "aspect", required: false, value: "finite number, default 16/9" },
      { name: "near", required: false, value: "finite number, default 0.1" },
      { name: "far", required: false, value: "finite number, default 2000" },
    ],
  },
  {
    name: "CharacterBody",
    summary: "Marks a kinematic character. Collider radius/halfHeight and Primitive radius still apply.",
    fields: [
      { name: "offset", required: false, value: "finite number, default 0.01" },
      { name: "autostepMaxHeight", required: false, value: "finite number" },
      { name: "autostepMinWidth", required: false, value: "finite number" },
    ],
  },
  {
    name: "Collider",
    summary: "Physics shape. Shape falls back to Primitive.kind, then box.",
    fields: [
      { name: "shape", required: false, value: '"box" | "sphere" | "ball" | "capsule"' },
      { name: "radius", required: false, value: "finite number" },
      { name: "halfHeight", required: false, value: "finite number" },
      { name: "halfExtents", required: false, value: "vec3 of finite numbers" },
      { name: "size", required: false, value: "vec3 of finite numbers; half extents are size/2" },
      { name: "friction", required: false, value: "finite number" },
      { name: "restitution", required: false, value: "finite number" },
    ],
  },
  {
    name: "Light",
    summary: "Scene light. Unknown kind values are rejected at projection time.",
    fields: [
      { name: "kind", required: false, value: '"ambient" | "point" | "directional", default "directional"' },
      { name: "color", required: false, value: 'CSS color string, default "#ffffff"' },
      { name: "intensity", required: false, value: "finite number, default 1" },
    ],
  },
  {
    name: "Model",
    summary: "GLB projection. Ignored unless assetId is a string.",
    fields: [{ name: "assetId", required: true, value: "string" }],
  },
  {
    name: "NavMesh",
    summary: "Navigation source. Use dataBase64, or positions together with indices. The first matching entity wins.",
    fields: [
      { name: "dataBase64", required: false, value: "string; serialized navmesh, preferred over positions" },
      { name: "positions", required: false, value: "number array; used with indices when dataBase64 is absent" },
      { name: "indices", required: false, value: "number array; used with positions when dataBase64 is absent" },
      { name: "config", required: false, value: "JSON object passed to the baker" },
    ],
  },
  {
    name: "Primitive",
    summary: "Mesh primitive. Unknown kind values are rejected at projection time.",
    fields: [
      { name: "kind", required: false, value: '"box" | "sphere" | "plane", default "box"' },
      { name: "color", required: false, value: 'CSS color string, default "#d9e6ff"' },
      { name: "roughness", required: false, value: "finite number, default 0.5" },
      { name: "metalness", required: false, value: "finite number, default 0.1" },
      { name: "size", required: false, value: "vec3 of finite numbers, box default [1, 1, 1]" },
      { name: "radius", required: false, value: "finite number, sphere default 0.5" },
      { name: "segments", required: false, value: "finite number, sphere default 24, minimum 8" },
      { name: "width", required: false, value: "finite number, plane default 10" },
      { name: "height", required: false, value: "finite number, plane default 10" },
    ],
  },
  {
    name: "RigidBody",
    summary: "Physics body type. Absent type is treated as fixed when a collider or character is present.",
    fields: [
      {
        name: "type",
        required: false,
        value: '"fixed" | "dynamic" | "kinematic" | "kinematicpositionbased", default "fixed"',
      },
      { name: "gravityScale", required: false, value: "finite number, dynamic bodies only" },
    ],
  },
  {
    name: "Script",
    summary: "Binds a registered gameplay script. Ignored unless scriptId is a string.",
    fields: [{ name: "scriptId", required: true, value: "string" }],
  },
  {
    name: "Transform",
    summary: "Local position, rotation in radians, and scale. Missing fields use identity defaults.",
    fields: [
      { name: "position", required: false, value: "vec3 of finite numbers, default [0, 0, 0]" },
      { name: "rotation", required: false, value: "vec3 of finite numbers, default [0, 0, 0]" },
      { name: "scale", required: false, value: "vec3 of finite numbers, default [1, 1, 1]" },
    ],
  },
];

function cloneField(field: RuntimeComponentField): RuntimeComponentField {
  return { name: field.name, required: field.required, value: field.value };
}

/** Read-only description of runtime-interpreted entity components. */
export function listRuntimeComponents(): RuntimeComponentCatalog {
  return {
    schemaVersion: 1,
    components: components.map((component) => ({
      name: component.name,
      summary: component.summary,
      fields: component.fields.map(cloneField),
    })),
  };
}
