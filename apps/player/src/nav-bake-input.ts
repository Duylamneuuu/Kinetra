// Builds the options object handed to RecastNavMesh.bake from a bridge "bake navigation" request.
// Extracted from the runtime controller so the merge rule can be tested under plain Node (the
// controller needs a WebGL renderer).
//
// The request's `config` comes straight from the bridge (untrusted JSON). The geometry buffers the
// request validated are authoritative: a config that also carries `positions` / `indices` keys used
// to be spread AFTER them and silently replaced the validated geometry (with whatever the config
// held, including garbage), so the bake ran on different data than the request, the log line, and
// the caller described.

export interface NavBakeRequest {
  readonly positions?: number[] | undefined;
  readonly indices?: number[] | undefined;
  readonly config?: Record<string, unknown> | undefined;
}

export type NavBakeOptions = Record<string, unknown> & {
  positions: number[];
  indices: number[];
};

export function buildNavBakeOptions(request: NavBakeRequest): NavBakeOptions {
  const { positions, indices } = request;
  if (!positions || !indices) {
    throw new Error("Navigation bake requires positions and indices geometry buffers");
  }
  const config =
    request.config !== null &&
    typeof request.config === "object" &&
    !Array.isArray(request.config)
      ? request.config
      : {};
  // Geometry last: it always wins over same-named config keys.
  return { ...config, positions, indices };
}
