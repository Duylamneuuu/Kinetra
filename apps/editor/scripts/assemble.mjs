import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, "..");
const distRoot = join(appRoot, "dist");
const packageRoot = join(distRoot, "package");

await rm(packageRoot, { recursive: true, force: true });
await mkdir(packageRoot, { recursive: true });

await cp(join(distRoot, "web"), join(packageRoot, "web"), {
  recursive: true,
});
await cp(
  join(distRoot, "electron"),
  join(packageRoot, "electron"),
  { recursive: true },
);

await writeFile(
  join(packageRoot, "package.json"),
  `${JSON.stringify(
    {
      name: "kinetra-editor",
      productName: "Kinetra Editor",
      version: "0.0.0",
      private: true,
      type: "module",
      main: "electron/main.js",
    },
    null,
    2,
  )}\n`,
);

console.log("Assembled Kinetra editor:", packageRoot);
