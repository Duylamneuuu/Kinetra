import { createSyntheticWav } from "@kinetra/audio";

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

// Deterministic audio clips created without network or third-party assets
export const ARENA_SFX_HIT_ASSET_ID = "asset_arena_sfx_hit";
export const ARENA_SFX_WIN_ASSET_ID = "asset_arena_sfx_win";
export const ARENA_SFX_LOSE_ASSET_ID = "asset_arena_sfx_lose";

export const arenaAudioBytes: Record<string, Uint8Array> = {
  [ARENA_SFX_HIT_ASSET_ID]: createSyntheticWav({
    frequency: 220,
    durationSeconds: 0.15,
    sampleRate: 22050,
  }),
  [ARENA_SFX_WIN_ASSET_ID]: createSyntheticWav({
    frequency: 880,
    durationSeconds: 0.3,
    sampleRate: 22050,
  }),
  [ARENA_SFX_LOSE_ASSET_ID]: createSyntheticWav({
    frequency: 130,
    durationSeconds: 0.35,
    sampleRate: 22050,
  }),
};

export const arenaAudioAssets: Record<string, string> = {
  [ARENA_SFX_HIT_ASSET_ID]: toBase64(arenaAudioBytes[ARENA_SFX_HIT_ASSET_ID]!),
  [ARENA_SFX_WIN_ASSET_ID]: toBase64(arenaAudioBytes[ARENA_SFX_WIN_ASSET_ID]!),
  [ARENA_SFX_LOSE_ASSET_ID]: toBase64(arenaAudioBytes[ARENA_SFX_LOSE_ASSET_ID]!),
};
