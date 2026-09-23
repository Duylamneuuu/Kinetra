import packager from "@electron/packager";
import { access, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, "..");
const sourceDir = join(appRoot, "dist", "package");
const outDir = join(appRoot, "release");

/**
 * Package the assembled player as a portable desktop folder.
 * Windows still clears the whole release directory, matching the original
 * package:win behavior. Linux removes only its own output folder.
 */
export async function packageDesktop(platform) {
  if (platform !== "win32" && platform !== "linux") {
    throw new Error(`Unsupported package platform: ${String(platform)}`);
  }

  const arch = "x64";
  const label = platform === "win32" ? "Windows" : "Linux";
  const executableFile = platform === "win32" ? "KinetraGame.exe" : "KinetraGame";

  if (platform === "win32") {
    await rm(outDir, { recursive: true, force: true });
  } else {
    await rm(join(outDir, `KinetraGame-${platform}-${arch}`), {
      recursive: true,
      force: true,
    });
  }

  const appPaths = await packager({
    dir: sourceDir,
    out: outDir,
    name: "KinetraGame",
    executableName: "KinetraGame",
    platform,
    arch,
    electronVersion: "38.0.0",
    overwrite: true,
    asar: true,
    prune: false,
  });

  if (appPaths.length !== 1) {
    throw new Error(`Expected one ${label} package, received ${appPaths.length}`);
  }

  const exe = join(appPaths[0], executableFile);
  await access(exe);
  console.log(`Packaged ${label} executable:`, exe);
  return exe;
}
