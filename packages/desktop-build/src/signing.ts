import type { WindowsReleaseManifest } from "./release.js";

export interface SigningPlan {
  provider:"signtool"|"external";
  executable?:string;
  args?:string[];
  description:string;
}

export function createSigningPlan(
  manifest:WindowsReleaseManifest,
  artifactPath:string,
):SigningPlan|undefined{
  const signing=manifest.signing;
  if(!signing) return undefined;

  if(signing.provider==="external"){
    return{
      provider:"external",
      description:`External signing step: ${signing.commandLabel} for ${artifactPath}`,
    };
  }

  const args=[
    "sign",
    "/fd","SHA256",
    "/f",signing.certificatePath,
  ];

  if(signing.timestampUrl){
    args.push("/tr",signing.timestampUrl,"/td","SHA256");
  }

  args.push(artifactPath);

  return{
    provider:"signtool",
    executable:"signtool.exe",
    args,
    description:`Authenticode sign ${artifactPath}`,
  };
}
