import assert from "node:assert/strict";
import test from "node:test";
import { blenderHeadlessArgs, runBlenderExport, type ProcessRunner } from "../src/index.js";

const options={
  blenderExecutable:"blender",
  sourceBlend:"assets/source/hero.blend",
  outputGlb:"assets/imported/hero.glb",
  pythonScript:"scripts/export_glb.py",
};

test("builds deterministic Blender headless arguments",()=>{
  assert.deepEqual(blenderHeadlessArgs(options),[
    "--background","assets/source/hero.blend",
    "--python","scripts/export_glb.py",
    "--","--output","assets/imported/hero.glb",
  ]);
});

test("runner boundary can be verified without requiring Blender",async()=>{
  const calls:Array<{exe:string;args:string[]}>=[];

  const runner:ProcessRunner={
    async run(exe,args){
      calls.push({exe,args});
      return {code:0,stdout:"ok",stderr:""};
    }
  };

  await runBlenderExport(options,runner);
  assert.equal(calls[0]?.exe,"blender");
  assert.deepEqual(calls[0]?.args,blenderHeadlessArgs(options));
});
