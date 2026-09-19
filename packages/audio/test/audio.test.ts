import assert from "node:assert/strict";
import test from "node:test";
import { AudioMixerModel } from "../src/index.js";

test("audio bus gain and mute propagate through hierarchy",()=>{
  const mixer=new AudioMixerModel([
    {id:"master",gain:0.8},
    {id:"music",parentId:"master",gain:0.5},
    {id:"sfx",parentId:"master",gain:1},
  ]);
  assert.equal(mixer.effectiveGain("music"),0.4);
  mixer.setMuted("master",true);
  assert.equal(mixer.effectiveGain("music"),0);
  assert.equal(mixer.effectiveGain("sfx"),0);
});
