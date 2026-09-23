import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export class InfrastructureError extends Error {
  readonly code: string;

  constructor(message: string, code = "INFRASTRUCTURE_ERROR") {
    super(message);
    this.name = "InfrastructureError";
    this.code = code;
  }
}

export function findRepositoryRoot(): string {
  let current = dirname(fileURLToPath(import.meta.url));
  while (true) {
    if (existsSync(join(current, "pnpm-workspace.yaml"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
}

export interface PackagedExecutableResolution {
  path: string;
  source: "env" | "repository";
}

export interface ResolvePackagedExecutableOptions {
  platform?: NodeJS.Platform;
  repositoryRoot?: string;
}

export function packagedExecutableRelativePath(platform: NodeJS.Platform): string {
  switch (platform) {
    case "win32":
      return "apps/player/release/KinetraGame-win32-x64/KinetraGame.exe";
    case "linux":
      return "apps/player/release/KinetraGame-linux-x64/KinetraGame";
    default:
      throw new InfrastructureError(
        `No packaged Kinetra executable is defined for platform "${platform}".`,
        "PACKAGED_PLATFORM_UNSUPPORTED",
      );
  }
}

export function packagedBuildCommand(platform: NodeJS.Platform): string {
  switch (platform) {
    case "win32":
      return "pnpm --filter @kinetra/player package:win";
    case "linux":
      return "pnpm --filter @kinetra/player package:linux";
    default:
      throw new InfrastructureError(
        `No packaged Kinetra build command is defined for platform "${platform}".`,
        "PACKAGED_PLATFORM_UNSUPPORTED",
      );
  }
}

/**
 * Windows always launches real Electron acceptance.
 * Linux launches it only for an explicit packaged executable under a display.
 * Dev-Electron Linux proof is a separate lane and must not be implied here.
 */
export function canLaunchHostedElectronAcceptance(): boolean {
  if (process.platform === "win32") {
    return true;
  }
  if (process.platform === "linux") {
    return Boolean(process.env.DISPLAY) && Boolean(process.env.KINETRA_RUNTIME_EXECUTABLE);
  }
  return false;
}

export function resolvePackagedExecutable(
  options: ResolvePackagedExecutableOptions = {},
): PackagedExecutableResolution {
  const platform = options.platform ?? process.platform;

  if (process.env.KINETRA_RUNTIME_EXECUTABLE) {
    const envPath = resolve(process.env.KINETRA_RUNTIME_EXECUTABLE);
    if (existsSync(envPath)) {
      return { path: envPath, source: "env" };
    }
    throw new InfrastructureError(
      `Configured KINETRA_RUNTIME_EXECUTABLE not found: ${envPath}`,
      "CONFIGURED_EXECUTABLE_NOT_FOUND",
    );
  }

  const relativePath = packagedExecutableRelativePath(platform);
  const repoRoot = options.repositoryRoot ?? findRepositoryRoot();
  const repoCandidate = resolve(repoRoot, relativePath);

  if (existsSync(repoCandidate)) {
    return { path: repoCandidate, source: "repository" };
  }

  throw new InfrastructureError(
    `Packaged executable not found at "${repoCandidate}". Build it first with: ${packagedBuildCommand(platform)}`,
    "PACKAGED_EXECUTABLE_NOT_FOUND",
  );
}

export function isPackagedExecutableAvailable(): boolean {
  try {
    resolvePackagedExecutable();
    return true;
  } catch {
    return false;
  }
}
