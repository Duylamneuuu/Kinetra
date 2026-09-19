#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

import { KinetraAgentService } from "./service.js";
import { createKinetraMcpServer } from "./server.js";

function projectPathFromArgs(): string {
  const explicitIndex = process.argv.indexOf("--project");
  const explicit =
    explicitIndex >= 0 && explicitIndex + 1 < process.argv.length
      ? process.argv[explicitIndex + 1]
      : undefined;

  const projectPath = explicit ?? process.env.KINETRA_PROJECT;

  if (!projectPath) {
    throw new Error(
      'Kinetra MCP requires --project <path> or the KINETRA_PROJECT environment variable.',
    );
  }

  return projectPath;
}

async function main(): Promise<void> {
  const service = await KinetraAgentService.fromFile(projectPathFromArgs());
  const server: McpServer = createKinetraMcpServer(service);
  const transport = new StdioServerTransport();

  await server.connect(transport);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
