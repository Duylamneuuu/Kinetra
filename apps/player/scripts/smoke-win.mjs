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

console.log("Running real packaged acceptance suite (MCP test.runAcceptance)...");
const testRun = spawnSync(process.execPath, ["--test", acceptanceTestFile], {
  stdio: "inherit",
  env: {
    ...process.env,
    KINETRA_RUNTIME_EXECUTABLE: exe,
  },
});

if (testRun.status !== 0) {
  throw new Error(`Packaged acceptance test failed with exit code ${String(testRun.status)}`);
}

console.log("Packaged Windows acceptance tests passed successfully.");

const arenaTestFile = join(
  here,
  "..",
  "..",
  "..",
  "packages",
  "verification",
  "dist",
  "test",
  "real-arena.test.js",
);

console.log("Running real packaged arena test suite...");
const arenaRun = spawnSync(process.execPath, ["--test", arenaTestFile], {
  stdio: "inherit",
  env: {
    ...process.env,
    KINETRA_RUNTIME_EXECUTABLE: exe,
  },
});

if (arenaRun.status !== 0) {
  throw new Error(`Packaged arena test failed with exit code ${String(arenaRun.status)}`);
}

console.log("Packaged Windows arena tests passed successfully.");

const shellTestFile = join(
  here,
  "..",
  "..",
  "..",
  "packages",
  "verification",
  "dist",
  "test",
  "real-game-shell.test.js",
);

console.log("Running real packaged game shell test suite...");
const shellRun = spawnSync(process.execPath, ["--test", shellTestFile], {
  stdio: "inherit",
  env: {
    ...process.env,
    KINETRA_RUNTIME_EXECUTABLE: exe,
  },
});

if (shellRun.status !== 0) {
  throw new Error(`Packaged game shell test failed with exit code ${String(shellRun.status)}`);
}

console.log("Packaged Windows game shell tests passed successfully.");

