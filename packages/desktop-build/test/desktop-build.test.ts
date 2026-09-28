import assert from "node:assert/strict";
import test from "node:test";
import {
  createReleaseCandidatePlan,
  createSigningPlan,
  generateAppBuildVdf,
  generateDepotVdf,
  NullSteamBridge,
  type WindowsReleaseManifest,
} from "../src/index.js";

const manifest:WindowsReleaseManifest={
  schemaVersion:1,
  productName:"KinetraGame",
  version:"0.1.0",
  executableName:"KinetraGame",
  sourceDirectory:"dist/package",
  outputDirectory:"release",
  portable:true,
  installer:true,
  signing:{
    provider:"signtool",
    certificatePath:"C:/secure/signing.pfx",
    timestampUrl:"https://timestamp.example.test",
  },
};

test("release plan requires packaged launch and acceptance gates",()=>{
  const plan=createReleaseCandidatePlan(manifest);
  assert.match(plan.layout.executablePath,/KinetraGame\.exe$/);
  assert.match(plan.layout.installerPath??"",/Setup\.exe$/);
  assert.deepEqual(plan.gates,[
    "workspace-check","package-windows","launch-packaged-executable","acceptance-suite"
  ]);
  assert.equal(plan.signing.length,2);
});

test("signing plan never embeds passwords or secrets",()=>{
  const plan=createSigningPlan(manifest,"release/KinetraGame.exe");
  assert.equal(plan?.provider,"signtool");
  assert.ok(plan?.args?.includes("C:/secure/signing.pfx"));
  assert.ok(!plan?.args?.some(arg=>/password|secret/i.test(arg)));
});

test("SteamPipe VDF generation is deterministic and escapes inputs",()=>{
  const depot=generateDepotVdf({
    depotId:12346,
    contentRoot:"C:\\build\\content",
    exclude:["*.pdb"],
  });
  assert.match(depot,/"DepotID" "12346"/);
  assert.match(depot,/"FileExclusion" "\*\.pdb"/);

  const app=generateAppBuildVdf({
    appId:12345,
    description:'Kinetra "RC1"',
    buildOutput:"C:\\build\\steam-output",
    contentRoot:"C:\\build\\content",
    preview:true,
    depots:[
      {depotId:12347,contentRoot:"content"},
      {depotId:12346,contentRoot:"content"},
    ],
  });
  assert.ok(app.indexOf("12346")<app.indexOf("12347"));
  assert.match(app,/Kinetra \\"RC1\\"/);
});

test("Steam remains optional through null bridge",async()=>{
  const steam=new NullSteamBridge();
  assert.equal(steam.isAvailable(),false);
  assert.equal(steam.overlayAvailable(),false);
  await steam.unlockAchievement("FIRST_BOOT");
  await steam.setStat("wins",1);
  assert.equal(await steam.getStat("wins"),undefined);
});
