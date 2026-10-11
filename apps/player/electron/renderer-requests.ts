// Pending main -> renderer request bookkeeping for the Electron runtime bridge.
//
// Kept free of any `electron` import so it can be unit-tested under plain Node.
// The inline version in main.ts had three holes: (1) when `webContents.send`
// threw, the pending entry and its timer leaked (the timer kept the main
// process alive and the entry sat in the map until the timeout); (2) when the
// window closed or the renderer process died, every in-flight request waited
// out its full timeout instead of failing at once; (3) a request issued after
// the window was gone was still queued. `RendererRequestTracker` owns the map
// and settles every request exactly once.

export interface RendererCommandMessage {
  id: string;
  method: string;
  params: unknown;
}

export interface RendererRequestTrackerOptions {
  /** Delivers one command to the renderer. May throw (destroyed webContents). */
  send(message: RendererCommandMessage): void;
  /** Default per-request timeout. */
  defaultTimeoutMs?: number;
}

interface PendingRendererRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export const DEFAULT_RENDERER_TIMEOUT_MS = 10_000;

export class RendererRequestTracker {
  readonly #send: (message: RendererCommandMessage) => void;
  readonly #defaultTimeoutMs: number;
  readonly #pending = new Map<string, PendingRendererRequest>();
  #counter = 0;
  #closedReason: Error | undefined;

  constructor(options: RendererRequestTrackerOptions) {
    this.#send = options.send;
    this.#defaultTimeoutMs =
      options.defaultTimeoutMs ?? DEFAULT_RENDERER_TIMEOUT_MS;
  }

  get pendingCount(): number {
    return this.#pending.size;
  }

  get closed(): boolean {
    return this.#closedReason !== undefined;
  }

  call(
    method: string,
    params: unknown = {},
    timeoutMs: number = this.#defaultTimeoutMs,
  ): Promise<unknown> {
    if (this.#closedReason) {
      return Promise.reject(this.#closedReason);
    }

    const id = `renderer_${++this.#counter}`;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Renderer command "${method}" timed out`));
      }, timeoutMs);

      this.#pending.set(id, { resolve, reject, timer });

      try {
        this.#send({ id, method, params });
      } catch (error) {
        // The command never reached the renderer: do not leave a timer and a
        // map entry behind for a reply that cannot come.
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(
          new Error(
            `Renderer command "${method}" could not be delivered: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        );
      }
    });
  }

  /** Settles one request with a renderer reply. False when the id is not pending. */
  respond(
    id: string,
    reply:
      | { ok: true; result?: unknown }
      | { ok: false; error?: string | undefined },
  ): boolean {
    const pending = this.#take(id);
    if (!pending) {
      return false;
    }

    if (reply.ok) {
      pending.resolve(reply.result);
    } else {
      pending.reject(new Error(reply.error ?? "Unknown renderer runtime failure"));
    }
    return true;
  }

  /** Fails one request with the given error. False when the id is not pending. */
  fail(id: string, error: Error): boolean {
    const pending = this.#take(id);
    if (!pending) {
      return false;
    }
    pending.reject(error);
    return true;
  }

  /** Fails every in-flight request at once; later calls still work. */
  rejectAll(error: Error): number {
    const ids = [...this.#pending.keys()];
    for (const id of ids) {
      this.#take(id)?.reject(error);
    }
    return ids.length;
  }

  /** The renderer is gone for good: fail in-flight work now and refuse new work. */
  close(error: Error): void {
    this.#closedReason ??= error;
    this.rejectAll(error);
  }

  #take(id: string): PendingRendererRequest | undefined {
    const pending = this.#pending.get(id);
    if (!pending) {
      return undefined;
    }
    clearTimeout(pending.timer);
    this.#pending.delete(id);
    return pending;
  }
}
