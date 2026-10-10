/**
 * Replace-a-held-resource helper for the player runtime (nav mesh and similar disposable handles).
 *
 * `bakeNavigation` / `loadNavigation` used to dispose the current nav mesh first and only then
 * validate / bake / decode the replacement. A rejected request (missing buffers, bad base64,
 * Recast refusing the geometry) therefore destroyed a perfectly good mesh while
 * `navigationState` still claimed `hasNavMesh: true` with the old serialized bytes, so the next
 * `computePath` threw "disposed" and a later save captured a mesh that no longer existed.
 * It also leaked: two overlapping bakes both assigned `#navMesh`, and a bake that finished after
 * `stop()` re-populated a runtime that had already been torn down.
 *
 * Here the replacement is built first. Only a successful build disposes the previous resource,
 * and a build that finished after it was cancelled is disposed instead of installed.
 *
 * Free of DOM / Electron / Three.js imports so it can be unit-tested under plain Node.
 */

export interface DisposableResource {
  dispose(): void;
}

export class ResourceSwapCancelledError extends Error {
  readonly code = "runtime.resource.cancelled";
  constructor(message = "The runtime was stopped before the replacement resource was ready") {
    super(message);
    this.name = "ResourceSwapCancelledError";
  }
}

export interface ReplaceDisposableOptions<T extends DisposableResource> {
  /** Reads the resource that is installed right now (called after `create` settles, not before). */
  current(): T | undefined;
  /** Builds the replacement. May throw/reject; the installed resource is then left untouched. */
  create(): Promise<T> | T;
  /** Installs the replacement. Only called once `create` succeeded and the swap was not cancelled. */
  install(next: T): void;
  /** True once the owner no longer wants a result (for example the runtime was stopped). */
  isCancelled?(): boolean;
}

/** Builds a replacement, then installs it and disposes the old resource. Returns the new one. */
export async function replaceDisposable<T extends DisposableResource>(
  options: ReplaceDisposableOptions<T>,
): Promise<T> {
  const next = await options.create();

  if (options.isCancelled?.()) {
    next.dispose();
    throw new ResourceSwapCancelledError();
  }

  const previous = options.current();
  options.install(next);
  if (previous !== undefined && previous !== next) {
    previous.dispose();
  }
  return next;
}
