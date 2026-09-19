#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

import { ElectronRuntimeHost } from "./electron-runtime.js";
import type { RuntimeHost } from "./runtime.js";
import { KinetraAgentService } from "./service.js";
import { createKinetraMcpServer } from "./server.js";

function argumentValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 && index + 1 < process.argv.length
    ? process.argv[index + 1]
    : undefined;
}

function projectPathFromArgs(): string {
  const projectPath =
    argumentValue("--project") ?? process.env.KINETRA_PROJECT;

  if (!projectPath) {
    throw new Error(
      "Kinetra MCP requires --project <path> or the KINETRA_PROJECT environment variable.",
    );
  }

  return projectPath;
}

function runtimeFromArgs(): RuntimeHost | undefined {
  const mode =
    argumentValue("--runtime") ??
    process.env.KINETRA_RUNTIME ??
    "local";

  switch (mode) {
    case "local":
      return undefined;
    case "electron":
      return new ElectronRuntimeHost();
    default:
      throw new Error(
        `Unsupported Kinetra runtime "${mode}". Use local or electron.`,
      );
  }
}

async function main(): Promise<void> {
  const runtime = runtimeFromArgs();
  const service = await KinetraAgentService.fromFile(
    projectPathFromArgs(),
    runtime ? { runtime } : {},
  );
  const server: McpServer = createKinetraMcpServer(service);
  const transport = new StdioServerTransport();

  await server.connect(transport);
}

main().catch((error: unknown) => {
  const message =
    error instanceof Error
      ? error.stack ?? error.message
      : String(error);
  console.error(message);
  process.exitCode = 1;
});
