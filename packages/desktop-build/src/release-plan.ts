import type { WindowsReleaseManifest } from "./release.js";
import { computeReleaseLayout,validateReleaseManifest } from "./release.js";
import { createSigningPlan, type SigningPlan } from "./signing.js";

export interface ReleaseCandidatePlan {
  manifest:WindowsReleaseManifest;
  layout:ReturnType<typeof computeReleaseLayout>;
  signing:SigningPlan[];
  gates:[
    "workspace-check",
    "package-windows",
    "launch-packaged-executable",
    "acceptance-suite"
  ];
}

export function createReleaseCandidatePlan(manifest:WindowsReleaseManifest):ReleaseCandidatePlan{
  validateReleaseManifest(manifest);
  const layout=computeReleaseLayout(manifest);
  const signing:SigningPlan[]=[];

  for(const artifact of [
    layout.executablePath,
    ...(layout.installerPath?[layout.installerPath]:[]),
  ]){
    const plan=createSigningPlan(manifest,artifact);
    if(plan) signing.push(plan);
  }

  return{
    manifest:structuredClone(manifest),
    layout,
    signing,
    gates:[
      "workspace-check",
      "package-windows",
      "launch-packaged-executable",
      "acceptance-suite",
    ],
  };
}
