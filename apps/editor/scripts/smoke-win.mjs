import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  throw new Error("editor smoke:win must run on Windows");
}

const here = dirname(fileURLToPath(import.meta.url));
const appPath = join(here, "..", "dist", "package");
const require = createRequire(import.meta.url);
const electron = require("electron");

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const exitCode = await new Promise((resolve, reject) => {
  const child = spawn(
    electron,
    [appPath, "--smoke-test"],
    {
      stdio: "inherit",
      windowsHide: true,
      env,
    },
  );

  const timer = setTimeout(() => {
    child.kill();
    reject(new Error("Kinetra Editor smoke test timed out"));
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
  throw new Error(
    `Kinetra Editor smoke test exited with code ${String(exitCode)}`,
  );
}

console.log("Kinetra Editor smoke test passed.");
