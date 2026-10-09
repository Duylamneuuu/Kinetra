import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  canLaunchHostedElectronAcceptance,
  findRepositoryRoot,
  InfrastructureError,
  isPackagedExecutableAvailable,
  packagedBuildCommand,
  packagedExecutableRelativePath,
  resolvePackagedExecutable,
} from "../src/packaged-resolver.js";

const ENV_KEYS = ["KINETRA_RUNTIME_EXECUTABLE", "DISPLAY"] as const;

/** Runs `run` with the given env overrides (undefined deletes) and an optional fake platform, then restores both. */
async function withHost<T>(
  host: { platform?: NodeJS.Platform; env?: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> },
  run: () => T | Promise<T>,
): Promise<T> {
  const previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  try {
    for (const [key, value] of Object.entries(host.env ?? {})) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (host.platform !== undefined) {
      Object.defineProperty(process, "platform", { value: host.platform, configurable: true });
    }
    return await run();
  } finally {
    for (const key of ENV_KEYS) {
      const value = previousEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
  }
}

function assertInfrastructure(code: string): (error: unknown) => boolean {
  return (error) => error instanceof InfrastructureError && error.code === code && error.name === "InfrastructureError";
}

test("every platform other than win32/linux is rejected with a structured PACKAGED_PLATFORM_UNSUPPORTED error", () => {
  for (const platform of ["darwin", "freebsd", "aix", "android"] as const) {
    assert.throws(() => packagedExecutableRelativePath(platform), assertInfrastructure("PACKAGED_PLATFORM_UNSUPPORTED"));
    assert.throws(() => packagedBuildCommand(platform), assertInfrastructure("PACKAGED_PLATFORM_UNSUPPORTED"));
    assert.throws(() => packagedBuildCommand(platform), new RegExp(`"${platform}"`));
  }
});

test("InfrastructureError defaults its code and is a real Error", () => {
  const error = new InfrastructureError("boom");
  assert.equal(error.code, "INFRASTRUCTURE_ERROR");
  assert.equal(error.message, "boom");
  assert.ok(error instanceof Error);
  assert.equal(new InfrastructureError("boom", "X").code, "X");
});

test("findRepositoryRoot returns the directory that holds pnpm-workspace.yaml", () => {
  const root = findRepositoryRoot();
  assert.ok(isAbsolute(root));
  assert.ok(existsSync(join(root, "pnpm-workspace.yaml")), `no pnpm-workspace.yaml in ${root}`);
  // The verification package lives inside the repository it reports.
  assert.ok(!relative(root, resolve(dirname(fileURLToPath(import.meta.url)), "..")).startsWith(".."));
});

test("canLaunchHostedElectronAcceptance: win32 always, linux only with DISPLAY and an explicit executable, others never", async () => {
  await withHost({ platform: "win32", env: { DISPLAY: undefined, KINETRA_RUNTIME_EXECUTABLE: undefined } }, () => {
    assert.equal(canLaunchHostedElectronAcceptance(), true);
  });
  await withHost({ platform: "darwin", env: { DISPLAY: ":99", KINETRA_RUNTIME_EXECUTABLE: "/x" } }, () => {
    assert.equal(canLaunchHostedElectronAcceptance(), false);
  });
  const linuxCases: Array<[string | undefined, string | undefined, boolean]> = [
    [undefined, undefined, false],
    [":99", undefined, false],
    [undefined, "/opt/KinetraGame", false],
    ["", "/opt/KinetraGame", false],
    [":99", "", false],
    [":99", "/opt/KinetraGame", true],
  ];
  for (const [display, executable, expected] of linuxCases) {
    await withHost({ platform: "linux", env: { DISPLAY: display, KINETRA_RUNTIME_EXECUTABLE: executable } }, () => {
      assert.equal(
        canLaunchHostedElectronAcceptance(),
        expected,
        `DISPLAY=${JSON.stringify(display)} KINETRA_RUNTIME_EXECUTABLE=${JSON.stringify(executable)}`,
      );
    });
  }
});

test("an empty KINETRA_RUNTIME_EXECUTABLE is treated as unset and falls through to the repository candidate", async () => {
  const root = await mkdtemp(join(tmpdir(), "kinetra-packaged-empty-env-"));
  try {
    const dir = join(root, "apps/player/release/KinetraGame-linux-x64");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "KinetraGame"), "");
    await withHost({ env: { KINETRA_RUNTIME_EXECUTABLE: "" } }, () => {
      const resolved = resolvePackagedExecutable({ platform: "linux", repositoryRoot: root });
      assert.equal(resolved.source, "repository");
      assert.equal(resolved.path, join(dir, "KinetraGame"));
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a relative KINETRA_RUNTIME_EXECUTABLE is resolved to an absolute path before the existence check", async () => {
  const root = await mkdtemp(join(tmpdir(), "kinetra-packaged-relative-env-"));
  const previousCwd = process.cwd();
  try {
    await writeFile(join(root, "Game"), "");
    process.chdir(root);
    await withHost({ env: { KINETRA_RUNTIME_EXECUTABLE: "./Game" } }, () => {
      const resolved = resolvePackagedExecutable({ platform: "linux" });
      assert.equal(resolved.source, "env");
      assert.ok(isAbsolute(resolved.path));
      assert.equal(resolved.path, resolve(root, "Game"));
    });
    await withHost({ env: { KINETRA_RUNTIME_EXECUTABLE: "./Missing" } }, () => {
      assert.throws(
        () => resolvePackagedExecutable({ platform: "linux" }),
        assertInfrastructure("CONFIGURED_EXECUTABLE_NOT_FOUND"),
      );
    });
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
});

test("an unsupported platform without an env override fails before touching the repository", async () => {
  await withHost({ env: { KINETRA_RUNTIME_EXECUTABLE: undefined } }, () => {
    assert.throws(
      () => resolvePackagedExecutable({ platform: "darwin", repositoryRoot: "/definitely/not/a/repo" }),
      assertInfrastructure("PACKAGED_PLATFORM_UNSUPPORTED"),
    );
  });
});

test("isPackagedExecutableAvailable never throws: it reports false for a bad override, an unsupported platform or a missing build", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kinetra-packaged-available-"));
  try {
    const exe = join(dir, "KinetraGame");
    await writeFile(exe, "");
    await withHost({ env: { KINETRA_RUNTIME_EXECUTABLE: exe } }, () => {
      assert.equal(isPackagedExecutableAvailable(), true);
    });
    await withHost({ env: { KINETRA_RUNTIME_EXECUTABLE: join(dir, "gone") } }, () => {
      assert.equal(isPackagedExecutableAvailable(), false);
    });
    await withHost({ platform: "darwin", env: { KINETRA_RUNTIME_EXECUTABLE: undefined } }, () => {
      assert.equal(isPackagedExecutableAvailable(), false);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
