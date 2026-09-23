import assert from "node:assert/strict";
import test from "node:test";

import {
  createProject,
  createScene,
  listRuntimeComponents,
  validateProject,
} from "../src/index.js";

const componentNames = [
  "Camera",
  "CharacterBody",
  "Collider",
  "Light",
  "Model",
  "NavMesh",
  "Primitive",
  "RigidBody",
  "Script",
  "Transform",
];

test("listRuntimeComponents names the interpreted components and their fields", () => {
  const catalog = listRuntimeComponents();
  assert.equal(catalog.schemaVersion, 1);
  assert.deepEqual(
    catalog.components.map((component) => component.name),
    componentNames,
  );

  const primitive = catalog.components.find((component) => component.name === "Primitive");
  assert.match(primitive?.fields.find((field) => field.name === "kind")?.value ?? "", /box/);
  assert.match(primitive?.fields.find((field) => field.name === "kind")?.value ?? "", /sphere/);
  assert.match(primitive?.fields.find((field) => field.name === "kind")?.value ?? "", /plane/);

  const light = catalog.components.find((component) => component.name === "Light");
  assert.match(light?.fields.find((field) => field.name === "kind")?.value ?? "", /ambient/);
  assert.match(light?.fields.find((field) => field.name === "kind")?.value ?? "", /point/);
  assert.match(light?.fields.find((field) => field.name === "kind")?.value ?? "", /directional/);

  const camera = catalog.components.find((component) => component.name === "Camera");
  assert.match(camera?.fields.find((field) => field.name === "type")?.value ?? "", /perspective/);

  assert.equal(
    catalog.components.find((component) => component.name === "Model")?.fields[0]?.required,
    true,
  );
  assert.equal(
    catalog.components.find((component) => component.name === "Script")?.fields[0]?.required,
    true,
  );
  assert.match(
    catalog.components.find((component) => component.name === "NavMesh")?.summary ?? "",
    /dataBase64/,
  );

  catalog.components[0]!.name = "mutated";
  assert.deepEqual(
    listRuntimeComponents().components.map((component) => component.name),
    componentNames,
  );
});

test("unknown component names stay valid project data", () => {
  const project = createProject({
    name: "Custom component",
    projectId: "project_custom_component",
  });
  const scene = createScene("Main", "scene_main");
  scene.entities.push({
    id: "entity_custom",
    name: "Custom",
    components: { Custom: { note: "kept" } },
  });
  project.scenes.push(scene);

  assert.deepEqual(validateProject(project), []);
  assert.equal(
    listRuntimeComponents().components.some((component) => component.name === "Custom"),
    false,
  );
});
