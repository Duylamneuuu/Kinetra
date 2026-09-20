import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  throw new Error("smoke:win must run on Windows");
}

const here = dirname(fileURLToPath(import.meta.url));
const exe = join(here, "..", "release", "KinetraGame-win32-x64", "KinetraGame.exe");

await access(exe);

const exitCode = await new Promise((resolve, reject) => {
  const child = spawn(exe, ["--smoke-test"], {
    stdio: "inherit",
    windowsHide: true,
  });

  const timer = setTimeout(() => {
    child.kill();
    reject(new Error("Packaged KinetraGame.exe smoke test timed out"));
  }, 20_000);

  child.once("error", (error) => {
    clearTimeout(timer);
    reject(error);
  });

  child.once("exit", (code) => {
    clearTimeout(timer);
    resolve(code);
  });
});

if (exitCode !== 0) {
  throw new Error(`Packaged KinetraGame.exe exited with code ${String(exitCode)}`);
}

console.log("Packaged Windows executable smoke test passed.");

// Prove real acceptance suite against packaged KinetraGame.exe
const { spawnSync } = await import("node:child_process");
const acceptanceTestFile = join(
  here,
  "..",
  "..",
  "..",
  "packages",
  "mcp-server",
  "dist",
  "test",
  "real-mcp-acceptance.test.js",
);

console.log("Running real packaged acceptance suite...");
const testRun = spawnSync(process.execPath, ["--test", acceptanceTestFile], {
  stdio: "inherit",
});

if (testRun.status !== 0) {
  throw new Error(`Packaged acceptance test failed with exit code ${String(testRun.status)}`);
}

console.log("Packaged Windows acceptance tests passed successfully.");
