import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { serializeProject } from "@kinetra/project-model";

import { createOrbRunAssetsManifest } from "./asset-manifest.js";
import { createOrbRunProject } from "./authoring.js";

/** Regenerate `orb-run.kinetra.json` from the authoring plan and `acceptance/assets.acceptance.json` from the content (run after editing either). */
const target = fileURLToPath(new URL("../../orb-run.kinetra.json", import.meta.url));
await writeFile(target, serializeProject(createOrbRunProject()), "utf8");
console.log(`wrote ${target}`);

const manifestTarget = fileURLToPath(new URL("../../acceptance/assets.acceptance.json", import.meta.url));
await writeFile(manifestTarget, `${JSON.stringify(await createOrbRunAssetsManifest(), null, 2)}\n`, "utf8");
console.log(`wrote ${manifestTarget}`);
