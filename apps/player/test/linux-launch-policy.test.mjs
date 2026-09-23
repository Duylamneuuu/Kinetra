import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const smoke = readFileSync(join(here, "../scripts/smoke-linux.mjs"), "utf8");
const runtime = readFileSync(
  join(here, "../../../packages/verification/src/electron-runtime.ts"),
  "utf8",
);

const block = runtime.match(
  /export const LINUX_ELECTRON_LAUNCH_ARGS = \[([\s\S]*?)\] as const;/,
);
assert.ok(block, "LINUX_ELECTRON_LAUNCH_ARGS must stay the launch policy");
const flags = [...block[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);

test("dev linux smoke uses the host launch policy instead of a second flag list", () => {
  assert.ok(flags.length >= 4);
  for (const flag of flags) {
    assert.equal(
      smoke.includes(flag),
      false,
      `${flag} is owned by LINUX_ELECTRON_LAUNCH_ARGS`,
    );
  }
  assert.match(smoke, /LINUX_ELECTRON_LAUNCH_ARGS/);
  assert.equal(smoke.includes("electronArgs:"), false);
});
