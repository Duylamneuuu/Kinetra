import { relative, resolve, sep } from "node:path";

export interface WindowsReleaseManifest {
  schemaVersion:1;
  productName:string;
  version:string;
  executableName:string;
  sourceDirectory:string;
  outputDirectory:string;
  portable:boolean;
  installer:boolean;
  signing?:
    | {provider:"signtool";certificatePath:string;timestampUrl?:string}
    | {provider:"external";commandLabel:string};
}

export interface ReleaseLayout {
  productName:string;
  version:string;
  executablePath:string;
  portableDirectory:string;
  installerPath?:string;
}

function safeSegment(value:string,label:string):string{
  if(!value.trim()) throw new Error(`${label} must not be empty`);
  if(/[\\/:*?"<>|]/.test(value)) throw new Error(`${label} contains invalid Windows filename characters`);
  return value;
}

export function validateReleaseManifest(manifest:WindowsReleaseManifest):void{
  if(manifest.schemaVersion!==1) throw new Error("Unsupported release manifest schema");
  safeSegment(manifest.productName,"productName");
  safeSegment(manifest.version,"version");
  safeSegment(manifest.executableName,"executableName");
  if(!manifest.sourceDirectory) throw new Error("sourceDirectory is required");
  if(!manifest.outputDirectory) throw new Error("outputDirectory is required");
  if(!manifest.portable&&!manifest.installer) throw new Error("At least one release artifact must be enabled");
}

export function computeReleaseLayout(manifest:WindowsReleaseManifest):ReleaseLayout{
  validateReleaseManifest(manifest);
  const root=resolve(manifest.outputDirectory);
  const portableDirectory=resolve(root,`${manifest.productName}-${manifest.version}-win-x64`);
  const executablePath=resolve(portableDirectory,`${manifest.executableName}.exe`);
  const installerPath=manifest.installer
    ? resolve(root,`${manifest.productName}-${manifest.version}-Setup.exe`)
    : undefined;

  return{
    productName:manifest.productName,
    version:manifest.version,
    executablePath,
    portableDirectory,
    ...(installerPath?{installerPath}:{}),
  };
}

export function ensureInside(root:string,path:string):void{
  const rel=relative(resolve(root),resolve(path));
  if(rel==="" ) return;
  if(rel.startsWith(".."+sep)||rel===".."||resolve(rel)===rel){
    throw new Error(`Path "${path}" escapes release root "${root}"`);
  }
}
