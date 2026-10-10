// Pure parsing of one line of the Electron runtime bridge protocol.
//
// Kept free of any `electron` import so it can be unit-tested under plain Node.
// A line that cannot become a request used to be dropped after a stderr note,
// which left the client (probe / MCP) waiting for a response until its
// timeout. Every non-empty line now yields either a request or a structured
// failure response that keeps the request id whenever the id is usable.

export interface BridgeRequest {
  id: string;
  method: string;
  params?: unknown;
}

export type BridgeRequestErrorCode =
  | "BRIDGE_INVALID_JSON"
  | "BRIDGE_INVALID_REQUEST"
  | "BRIDGE_INVALID_ID"
  | "BRIDGE_INVALID_METHOD";

export type BridgeResponseErrorCode = "BRIDGE_UNSERIALIZABLE_RESPONSE";

export interface BridgeRequestFailure {
  type: "response";
  /** The request id when it was a string; `null` when it could not be recovered. */
  id: string | null;
  ok: false;
  error: string;
  code: BridgeRequestErrorCode;
}

export type ParsedBridgeLine =
  | { ok: true; request: BridgeRequest }
  | { ok: false; response: BridgeRequestFailure };

function failure(
  id: string | null,
  code: BridgeRequestErrorCode,
  message: string,
): ParsedBridgeLine {
  return {
    ok: false,
    response: {
      type: "response",
      id,
      ok: false,
      error: `${code}: ${message}`,
      code,
    },
  };
}

/**
 * Renders one outgoing bridge message as exactly one newline-terminated JSON line. Never throws.
 *
 * A handler result that `JSON.stringify` rejects (circular reference, BigInt, a throwing
 * `toJSON`) used to make the bridge write throw inside an un-awaited async handler: no reply was
 * ever written and the client waited for its own timeout. Such a message is replaced by a
 * structured `BRIDGE_UNSERIALIZABLE_RESPONSE` failure that keeps the request id when there is one.
 */
export function serializeBridgeMessage(value: unknown): string {
  let reason: string;
  try {
    const text = JSON.stringify(value);
    if (typeof text === "string") {
      return `${text}\n`;
    }
    reason = "message has no JSON representation";
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error);
  }

  let id: string | null = null;
  try {
    const candidate = (value as { id?: unknown } | null | undefined)?.id;
    if (typeof candidate === "string") id = candidate;
  } catch {
    // A throwing getter must not stop the fallback reply.
  }

  const code: BridgeResponseErrorCode = "BRIDGE_UNSERIALIZABLE_RESPONSE";
  return `${JSON.stringify({
    type: "response",
    id,
    ok: false,
    error: `${code}: ${reason}`,
    code,
  })}\n`;
}

export interface RendererResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

/**
 * Validates a reply the renderer sent over IPC. A malformed reply (null, missing id, non-boolean
 * ok) used to throw inside the ipcMain listener, an uncaught main-process exception; it is now
 * reported as `null` so the caller can ignore it and let the pending request time out normally.
 */
export function normalizeRendererResponse(raw: unknown): RendererResponse | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const candidate = raw as Record<string, unknown>;
  if (typeof candidate.id !== "string" || typeof candidate.ok !== "boolean") return null;
  const response: RendererResponse = { id: candidate.id, ok: candidate.ok };
  if (candidate.result !== undefined) response.result = candidate.result;
  if (typeof candidate.error === "string") response.error = candidate.error;
  return response;
}

/** Parses one non-empty bridge line. Never throws. */
export function parseBridgeLine(line: string): ParsedBridgeLine {
  let parsed: unknown;

  try {
    parsed = JSON.parse(line) as unknown;
  } catch (error) {
    return failure(
      null,
      "BRIDGE_INVALID_JSON",
      error instanceof Error ? error.message : "line is not valid JSON",
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return failure(null, "BRIDGE_INVALID_REQUEST", "request must be a JSON object");
  }

  const candidate = parsed as Record<string, unknown>;
  const id = typeof candidate.id === "string" ? candidate.id : null;

  if (id === null) {
    // Without a string id the client cannot correlate a reply; id stays null.
    return failure(null, "BRIDGE_INVALID_ID", "request requires a string id");
  }

  if (typeof candidate.method !== "string") {
    return failure(id, "BRIDGE_INVALID_METHOD", "request requires a string method");
  }

  return {
    ok: true,
    request: {
      id,
      method: candidate.method,
      ...(candidate.params !== undefined ? { params: candidate.params } : {}),
    },
  };
}
