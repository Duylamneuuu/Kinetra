function vdf(value:string|number|boolean):string{
  return String(value).replace(/\\/g,"\\\\").replace(/"/g,'\\"');
}

export interface SteamDepotConfig {
  depotId:number;
  contentRoot:string;
  include?:string;
  exclude?:string[];
}

export interface SteamBuildConfig {
  appId:number;
  description:string;
  buildOutput:string;
  contentRoot:string;
  setLive?:string;
  preview?:boolean;
  depots:SteamDepotConfig[];
}

export function generateDepotVdf(config:SteamDepotConfig):string{
  if(!Number.isInteger(config.depotId)||config.depotId<=0) throw new Error("depotId must be positive integer");

  const lines=[
    '"DepotBuildConfig"',
    "{",
    `  "DepotID" "${vdf(config.depotId)}"`,
    `  "ContentRoot" "${vdf(config.contentRoot)}"`,
    '  "FileMapping"',
    "  {",
    `    "LocalPath" "${vdf(config.include??"*")}"`,
    '    "DepotPath" "."',
    '    "recursive" "1"',
    "  }",
  ];

  for(const exclude of config.exclude??[]){
    lines.push(`  "FileExclusion" "${vdf(exclude)}"`);
  }

  lines.push("}","");
  return lines.join("\n");
}

export function generateAppBuildVdf(config:SteamBuildConfig):string{
  if(!Number.isInteger(config.appId)||config.appId<=0) throw new Error("appId must be positive integer");
  if(config.depots.length===0) throw new Error("At least one depot is required");

  const lines=[
    '"appbuild"',
    "{",
    `  "appid" "${vdf(config.appId)}"`,
    `  "desc" "${vdf(config.description)}"`,
    `  "buildoutput" "${vdf(config.buildOutput)}"`,
    `  "contentroot" "${vdf(config.contentRoot)}"`,
    `  "preview" "${config.preview?"1":"0"}"`,
  ];

  if(config.setLive){
    lines.push(`  "setlive" "${vdf(config.setLive)}"`);
  }

  lines.push('  "depots"',"  {");
  for(const depot of [...config.depots].sort((a,b)=>a.depotId-b.depotId)){
    lines.push(`    "${depot.depotId}" "depot_build_${depot.depotId}.vdf"`);
  }
  lines.push("  }","}","");
  return lines.join("\n");
}

export interface SteamPlatformBridge {
  isAvailable():boolean;
  unlockAchievement(id:string):Promise<void>;
  setStat(name:string,value:number):Promise<void>;
  getStat(name:string):Promise<number|undefined>;
  overlayAvailable():boolean;
}

export class NullSteamBridge implements SteamPlatformBridge {
  isAvailable():boolean{return false;}
  async unlockAchievement(_id:string):Promise<void>{}
  async setStat(_name:string,_value:number):Promise<void>{}
  async getStat(_name:string):Promise<number|undefined>{return undefined;}
  overlayAvailable():boolean{return false;}
}
