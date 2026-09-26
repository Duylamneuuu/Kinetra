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

const loopTestFile = join(
  here,
  "..",
  "..",
  "..",
  "packages",
  "verification",
  "dist",
  "test",
  "real-gameplay-loop.test.js",
);

console.log("Running real packaged gameplay loop test suite...");
const loopRun = spawnSync(process.execPath, ["--test", loopTestFile], {
  stdio: "inherit",
  env: {
    ...process.env,
    KINETRA_RUNTIME_EXECUTABLE: exe,
  },
});

if (loopRun.status !== 0) {
  throw new Error(`Packaged gameplay loop test failed with exit code ${String(loopRun.status)}`);
}

console.log("Packaged Windows gameplay loop tests passed successfully.");

const combatTestFile = join(
  here,
  "..",
  "..",
  "..",
  "packages",
  "verification",
  "dist",
  "test",
  "real-combat.test.js",
);

console.log("Running real packaged combat test suite...");
const combatRun = spawnSync(process.execPath, ["--test", combatTestFile], {
  stdio: "inherit",
  env: {
    ...process.env,
    KINETRA_RUNTIME_EXECUTABLE: exe,
  },
});

if (combatRun.status !== 0) {
  throw new Error(`Packaged combat test failed with exit code ${String(combatRun.status)}`);
}

console.log("Packaged Windows combat tests passed successfully.");

const progressionTestFile = join(
  here,
  "..",
  "..",
  "..",
  "packages",
  "verification",
  "dist",
  "test",
  "real-combat-progression.test.js",
);

console.log("Running real packaged combat progression test suite...");
const progressionRun = spawnSync(process.execPath, ["--test", progressionTestFile], {
  stdio: "inherit",
  env: {
    ...process.env,
    KINETRA_RUNTIME_EXECUTABLE: exe,
  },
});

if (progressionRun.status !== 0) {
  throw new Error(`Packaged combat progression test failed with exit code ${String(progressionRun.status)}`);
}

console.log("Packaged Windows combat progression tests passed successfully.");

const characterAnimationTestFile = join(
  here,
  "..",
  "..",
  "..",
  "packages",
  "verification",
  "dist",
  "test",
  "real-character-animation.test.js",
);

console.log("Running real packaged character animation test suite...");
const characterAnimationRun = spawnSync(process.execPath, ["--test", characterAnimationTestFile], {
  stdio: "inherit",
  env: {
    ...process.env,
    KINETRA_RUNTIME_EXECUTABLE: exe,
  },
});

if (characterAnimationRun.status !== 0) {
  throw new Error(`Packaged character animation test failed with exit code ${String(characterAnimationRun.status)}`);
}

console.log("Packaged Windows character animation tests passed successfully.");

const humanoidRetargetTestFile = join(
  here,
  "..",
  "..",
  "..",
  "packages",
  "verification",
  "dist",
  "test",
  "real-humanoid-retarget.test.js",
);

console.log("Running real packaged humanoid retarget test suite...");
const humanoidRetargetRun = spawnSync(process.execPath, ["--test", humanoidRetargetTestFile], {
  stdio: "inherit",
  env: {
    ...process.env,
    KINETRA_RUNTIME_EXECUTABLE: exe,
  },
});

if (humanoidRetargetRun.status !== 0) {
  throw new Error(`Packaged humanoid retarget test failed with exit code ${String(humanoidRetargetRun.status)}`);
}

console.log("Packaged Windows humanoid retarget tests passed successfully.");

