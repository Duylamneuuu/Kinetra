import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  InfrastructureError,
  packagedBuildCommand,
  packagedExecutableRelativePath,
  resolvePackagedExecutable,
} from "../src/packaged-resolver.js";

test("packaged executable paths stay platform-specific", () => {
  assert.equal(
    packagedExecutableRelativePath("win32"),
    "apps/player/release/KinetraGame-win32-x64/KinetraGame.exe",
  );
  assert.equal(
    packagedExecutableRelativePath("linux"),
    "apps/player/release/KinetraGame-linux-x64/KinetraGame",
  );
  assert.equal(
    packagedBuildCommand("win32"),
    "pnpm --filter @kinetra/player package:win",
  );
  assert.equal(
    packagedBuildCommand("linux"),
    "pnpm --filter @kinetra/player package:linux",
  );
  assert.throws(
    () => packagedExecutableRelativePath("darwin"),
    (error: unknown) =>
      error instanceof InfrastructureError &&
      error.code === "PACKAGED_PLATFORM_UNSUPPORTED",
  );
});

test("KINETRA_RUNTIME_EXECUTABLE override wins and does not fall through", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kinetra-packaged-override-"));
  const exe = join(dir, "KinetraGame");
  await writeFile(exe, "");
  const previous = process.env.KINETRA_RUNTIME_EXECUTABLE;
  try {
    process.env.KINETRA_RUNTIME_EXECUTABLE = exe;
    const resolved = resolvePackagedExecutable({ platform: "linux" });
    assert.equal(resolved.source, "env");
    assert.equal(resolved.path, exe);

    process.env.KINETRA_RUNTIME_EXECUTABLE = join(dir, "missing-KinetraGame");
    assert.throws(
      () => resolvePackagedExecutable({ platform: "win32" }),
      (error: unknown) =>
        error instanceof InfrastructureError &&
        error.code === "CONFIGURED_EXECUTABLE_NOT_FOUND",
    );
  } finally {
    if (previous === undefined) {
      delete process.env.KINETRA_RUNTIME_EXECUTABLE;
    } else {
      process.env.KINETRA_RUNTIME_EXECUTABLE = previous;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test("repository resolution uses only the requested platform candidate", async () => {
  const root = await mkdtemp(join(tmpdir(), "kinetra-packaged-root-"));
  const linuxExe = join(
    root,
    "apps/player/release/KinetraGame-linux-x64/KinetraGame",
  );
  await mkdir(join(root, "apps/player/release/KinetraGame-linux-x64"), {
    recursive: true,
  });
  await writeFile(join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
  await writeFile(linuxExe, "");
  const previous = process.env.KINETRA_RUNTIME_EXECUTABLE;
  delete process.env.KINETRA_RUNTIME_EXECUTABLE;
  try {
    const linux = resolvePackagedExecutable({
      platform: "linux",
      repositoryRoot: root,
    });
    assert.equal(linux.source, "repository");
    assert.equal(linux.path, linuxExe);

    assert.throws(
      () =>
        resolvePackagedExecutable({
          platform: "win32",
          repositoryRoot: root,
        }),
      (error: unknown) =>
        error instanceof InfrastructureError &&
        error.code === "PACKAGED_EXECUTABLE_NOT_FOUND" &&
        error.message.includes("package:win") &&
        error.message.includes("KinetraGame.exe"),
    );
  } finally {
    if (previous === undefined) {
      delete process.env.KINETRA_RUNTIME_EXECUTABLE;
    } else {
      process.env.KINETRA_RUNTIME_EXECUTABLE = previous;
    }
    await rm(root, { recursive: true, force: true });
  }
});
