import { access } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  throw new Error("shipping:win must run on Windows");
}

const here = dirname(fileURLToPath(import.meta.url));
const exe = join(here, "..", "release", "KinetraGame-win32-x64", "KinetraGame.exe");

await access(exe);

const shippingTestFile = join(
  here,
  "..",
  "..",
  "..",
  "packages",
  "verification",
  "dist",
  "test",
  "real-shipping.test.js",
);

console.log("===============================================================================");
console.log("Kinetra P8 Final Gate — Packaged Windows Shipping Acceptance Suite");
console.log(`Executable: ${exe}`);
console.log("===============================================================================");

const shippingRun = spawnSync(process.execPath, ["--test", shippingTestFile], {
  stdio: "inherit",
  env: {
    ...process.env,
    KINETRA_RUNTIME_EXECUTABLE: exe,
  },
});

if (shippingRun.status !== 0) {
  throw new Error(
    `Packaged Windows shipping acceptance failed with exit code ${String(shippingRun.status)}`,
  );
}

console.log("===============================================================================");
console.log("Packaged Windows shipping acceptance gate PASSED.");
console.log("===============================================================================");
