import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, "..");
const distRoot = join(appRoot, "dist");
const packageRoot = join(distRoot, "package");

await rm(packageRoot, { recursive: true, force: true });
await mkdir(packageRoot, { recursive: true });

await cp(join(distRoot, "web"), join(packageRoot, "web"), { recursive: true });
await cp(join(distRoot, "electron"), join(packageRoot, "electron"), { recursive: true });

const saveStateSource = join(appRoot, "..", "..", "packages", "save-state");
const saveStateTarget = join(packageRoot, "node_modules", "@kinetra", "save-state");
await mkdir(saveStateTarget, { recursive: true });
await cp(join(saveStateSource, "dist"), join(saveStateTarget, "dist"), { recursive: true });
await cp(join(saveStateSource, "package.json"), join(saveStateTarget, "package.json"));

await writeFile(
  join(packageRoot, "package.json"),
  `${JSON.stringify(
    {
      name: "kinetra-game",
      productName: "KinetraGame",
      version: "0.0.0",
      private: true,
      type: "module",
      main: "electron/main.js",
      dependencies: {
        "@kinetra/save-state": "0.0.0",
      },
    },
    null,
    2,
  )}\n`,
);

console.log("Assembled Electron package source:", packageRoot);
