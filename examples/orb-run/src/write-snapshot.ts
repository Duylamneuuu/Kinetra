import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { serializeProject } from "@kinetra/project-model";

import { createOrbRunAssetsManifest } from "./asset-manifest.js";
import { createOrbRunProject } from "./authoring.js";
import { createOrbRunReplays } from "./replay-fixtures.js";

/**
 * Regenerate `orb-run.kinetra.json` from the authoring plan, `acceptance/assets.acceptance.json` from the content
 * and the golden replays in `acceptance/replays/` from the playtest bot (run after editing the plan, the content or the gameplay).
 */
const target = fileURLToPath(new URL("../../orb-run.kinetra.json", import.meta.url));
await writeFile(target, serializeProject(createOrbRunProject()), "utf8");
console.log(`wrote ${target}`);

const manifestTarget = fileURLToPath(new URL("../../acceptance/assets.acceptance.json", import.meta.url));
await writeFile(manifestTarget, `${JSON.stringify(await createOrbRunAssetsManifest(), null, 2)}\n`, "utf8");
console.log(`wrote ${manifestTarget}`);

const replays = await createOrbRunReplays();
await mkdir(fileURLToPath(new URL("../../acceptance/replays/", import.meta.url)), { recursive: true });
for (const [name, replay] of Object.entries(replays)) {
  const replayTarget = fileURLToPath(new URL(`../../acceptance/replays/${name}.replay.json`, import.meta.url));
  await writeFile(replayTarget, `${JSON.stringify(replay, null, 2)}\n`, "utf8");
  console.log(`wrote ${replayTarget}`);
}
