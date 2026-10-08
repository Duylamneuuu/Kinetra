import { InMemoryTransport } from "@modelcontextprotocol/server";
import { createKinetraMcpServer, type KinetraAgentService } from "@kinetra/mcp-server";

export interface ToolCallResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

/**
 * Minimal JSON-RPC client over the MCP in-memory transport. The engine does
 * not export a reusable test client yet (logged as an engine request), so
 * this mirrors packages/mcp-server/test/tool-error.test.ts.
 */
export function connectMcpClient(service: KinetraAgentService) {
  const server = createKinetraMcpServer(service);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  let nextId = 1;
  const pending = new Map<number, (value: unknown) => void>();

  clientTransport.onmessage = (message: unknown) => {
    const response = message as { id?: number };
    if (response.id !== undefined && pending.has(response.id)) {
      const resolve = pending.get(response.id);
      pending.delete(response.id);
      resolve?.(message);
    }
  };

  const connected = (async () => {
    await server.connect(serverTransport);
    await clientTransport.start();
  })();

  return {
    async callTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
      await connected;
      const id = nextId++;
      const response = await new Promise<{ result?: ToolCallResult; error?: { message: string } }>(
        (resolve) => {
          pending.set(id, resolve as (value: unknown) => void);
          void clientTransport.send({
            jsonrpc: "2.0",
            id,
            method: "tools/call",
            params: { name, arguments: args },
          });
        },
      );
      if (response.error) {
        return { isError: true, content: [{ type: "text", text: response.error.message }] };
      }
      return response.result ?? { content: [] };
    },
    /** Call a tool and parse its JSON text body, failing loudly on tool errors. */
    async callJson<T>(name: string, args: Record<string, unknown>): Promise<T> {
      const result = await this.callTool(name, args);
      const text = result.content[0]?.text ?? "";
      if (result.isError) throw new Error(`MCP tool ${name} failed: ${text}`);
      return JSON.parse(text) as T;
    },
    async close(): Promise<void> {
      await clientTransport.close();
      await serverTransport.close();
    },
  };
}
