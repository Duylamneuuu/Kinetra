import assert from "node:assert/strict";
import test from "node:test";
import { PlayerAudioController } from "../src/audio-controller.ts";

test("player audio bus errors name the default buses", async () => {
  const audio = new PlayerAudioController();
  assert.throws(
    () => audio.setBusGain("ghost", 0.5),
    /Unknown audio bus "ghost"[\s\S]*Available buses: master, music, sfx, voice/,
  );
  assert.throws(
    () => audio.setBusMuted("ghost", true),
    /Available buses: master, music, sfx, voice/,
  );

  const played = await audio.play({ assetId: "clip", bus: "ghost" });
  assert.equal(played.success, false);
  assert.match(
    played.error ?? "",
    /Available buses: master, music, sfx, voice/,
  );
});
