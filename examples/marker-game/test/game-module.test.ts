import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { hashBytes } from "@kinetra/asset-pipeline/pure";
import { ScriptHost, ScriptRegistry } from "@kinetra/core";

import {
  MARKER_FINGERPRINT,
  MARKER_SCRIPT_ID,
  MARKER_TOKEN,
  markerGameModule,
} from "../src/game-module.js";

test("the marker fingerprint is the pure asset-pipeline hash of the token", () => {
  assert.equal(markerGameModule.id, "marker");
  assert.equal(
    MARKER_FINGERPRINT,
    hashBytes(new TextEncoder().encode(MARKER_TOKEN)),
  );
  assert.equal(MARKER_FINGERPRINT.length, 64);
});

test("MarkerPulse counts updates and readGameState sums them", async () => {
  const registry = new ScriptRegistry();
  markerGameModule.registerScripts(registry, { sceneId: "scene_marker" });
  const host = new ScriptHost();
  const factory = registry.resolve(MARKER_SCRIPT_ID);
  assert.ok(factory);
  host.register({
    id: "entity_marker",
    scriptId: MARKER_SCRIPT_ID,
    context: { entityId: "entity_marker", sceneId: "scene_marker" },
    script: factory({ entityId: "entity_marker", sceneId: "scene_marker" }),
  });
  await host.startAll();
  host.update(1 / 60);
  host.update(1 / 60);
  const execution = host.getExecutionState("entity_marker");
  const game = markerGameModule.readGameState?.([
    {
      entityId: "entity_marker",
      scriptId: MARKER_SCRIPT_ID,
      ...(execution?.state ? { state: execution.state } : {}),
    },
  ]);
  assert.deepEqual(game, { pulses: 2, fingerprint: MARKER_FINGERPRINT });
});

test("the marker module bundles for the browser with no Node builtin", async () => {
  // This file runs from dist/test. esbuild is the copy Orb Run already depends on,
  // the same one scripts/bundle-gltf-web.mjs uses, so this example adds no dependency.
  const require = createRequire(new URL("../../../orb-run/package.json", import.meta.url));
  const esbuild = require("esbuild") as {
    build(options: Record<string, unknown>): Promise<{
      outputFiles?: Array<{ text: string }>;
      metafile?: { outputs: Record<string, { imports?: Array<{ path: string }> }> };
    }>;
  };
  const result = await esbuild.build({
    absWorkingDir: fileURLToPath(new URL("../..", import.meta.url)),
    entryPoints: ["src/game-module.ts"],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    write: false,
    metafile: true,
    logLevel: "silent",
  });
  const output = result.outputFiles?.[0];
  assert.ok(output);
  const text = output.text;
  assert.equal(text.includes("node:fs"), false);
  assert.equal(text.includes("node:path"), false);
  assert.equal(text.includes(MARKER_TOKEN), true);
  const imports = Object.values(result.metafile?.outputs ?? {}).flatMap(
    (entry) => entry.imports?.map((item) => item.path) ?? [],
  );
  assert.deepEqual(imports, []);
});
