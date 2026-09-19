export type FieldKind =
  | "vec3"
  | "number"
  | "string"
  | "boolean";

export interface ComponentFieldSchema {
  key: string;
  label: string;
  kind: FieldKind;
}

export interface ComponentSchema {
  name: string;
  fields: ComponentFieldSchema[];
}

export const COMPONENT_SCHEMAS: Record<string, ComponentSchema> = {
  Transform: {
    name: "Transform",
    fields: [
      { key: "position", label: "Position", kind: "vec3" },
      { key: "rotation", label: "Rotation", kind: "vec3" },
      { key: "scale", label: "Scale", kind: "vec3" },
    ],
  },
  Camera: {
    name: "Camera",
    fields: [
      { key: "fov", label: "FOV", kind: "number" },
      { key: "near", label: "Near", kind: "number" },
      { key: "far", label: "Far", kind: "number" },
    ],
  },
  Light: {
    name: "Light",
    fields: [
      { key: "kind", label: "Kind", kind: "string" },
      { key: "color", label: "Color", kind: "string" },
      { key: "intensity", label: "Intensity", kind: "number" },
    ],
  },
  Primitive: {
    name: "Primitive",
    fields: [
      { key: "kind", label: "Kind", kind: "string" },
      { key: "color", label: "Color", kind: "string" },
      { key: "size", label: "Size", kind: "vec3" },
    ],
  },
};
