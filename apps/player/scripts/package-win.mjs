import packager from "@electron/packager";
import { access, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, "..");
const sourceDir = join(appRoot, "dist", "package");
const outDir = join(appRoot, "release");

await rm(outDir, { recursive: true, force: true });

const appPaths = await packager({
  dir: sourceDir,
  out: outDir,
  name: "KinetraGame",
  executableName: "KinetraGame",
  platform: "win32",
  arch: "x64",
  electronVersion: "38.0.0",
  overwrite: true,
  asar: true,
  prune: true,
});

if (appPaths.length !== 1) {
  throw new Error(`Expected one Windows package, received ${appPaths.length}`);
}

const exe = join(appPaths[0], "KinetraGame.exe");
await access(exe);

console.log("Packaged Windows executable:", exe);
