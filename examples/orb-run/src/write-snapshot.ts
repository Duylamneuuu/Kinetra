import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { serializeProject } from "@kinetra/project-model";

import { createOrbRunProject } from "./authoring.js";

/** Regenerate `orb-run.kinetra.json` from the authoring plan (run after editing the plan). */
const target = fileURLToPath(new URL("../../orb-run.kinetra.json", import.meta.url));
await writeFile(target, serializeProject(createOrbRunProject()), "utf8");
console.log(`wrote ${target}`);
