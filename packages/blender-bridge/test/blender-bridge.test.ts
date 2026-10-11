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
    "--background",
    "--python-exit-code","1",
    "assets/source/hero.blend",
    "--python","scripts/export_glb.py",
    "--","--output","assets/imported/hero.glb",
  ]);
});

test("Blender is told to exit non-zero when the export script raises, before the script runs",()=>{
  // Blender exits 0 after a Python exception unless --python-exit-code is set, which would make a
  // failed export look like a success.
  const args=blenderHeadlessArgs(options);
  const exitCodeAt=args.indexOf("--python-exit-code");
  assert.ok(exitCodeAt>=0,"--python-exit-code must be passed");
  assert.equal(args[exitCodeAt+1],"1");
  assert.ok(exitCodeAt<args.indexOf("--python"),"--python-exit-code must precede --python");
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
