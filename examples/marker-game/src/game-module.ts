import { hashBytes } from "@kinetra/asset-pipeline/pure";
import type { GameModule, GameScript } from "@kinetra/core";

/** Stable bytes hashed by the browser-safe asset-pipeline entry. */
export const MARKER_TOKEN = "kinetra-marker";
export const MARKER_SCRIPT_ID = "MarkerPulse";
export const MARKER_FINGERPRINT = hashBytes(new TextEncoder().encode(MARKER_TOKEN));

class MarkerPulse implements GameScript {
  #pulses = 0;

  onUpdate(): void {
    this.#pulses += 1;
  }

  getState(): Record<string, unknown> {
    return { pulses: this.#pulses, fingerprint: MARKER_FINGERPRINT };
  }
}

/**
 * Second game module. It does not import Arena. `fingerprint` is computed with
 * `@kinetra/asset-pipeline/pure`, so a renderer bundle of this module is also a
 * bundle of that browser-safe entry.
 */
export const markerGameModule: GameModule = {
  id: "marker",
  registerScripts(registry) {
    registry.register(MARKER_SCRIPT_ID, () => new MarkerPulse());
  },
  readGameState(scripts) {
    let pulses = 0;
    for (const script of scripts) {
      if (script.scriptId !== MARKER_SCRIPT_ID) continue;
      const value = script.state?.pulses;
      if (typeof value === "number" && Number.isFinite(value)) pulses += value;
    }
    return { pulses, fingerprint: MARKER_FINGERPRINT };
  },
};
