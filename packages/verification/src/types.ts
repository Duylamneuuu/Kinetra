export interface RuntimeInput {
  action:string;
  phase:"press"|"release"|"hold";
  value?:number|[number,number];
  durationMs?:number;
}

export interface RuntimeSnapshot {
  running:boolean;
  sceneId?:string;
  state:Record<string,unknown>;
}

export interface RuntimeLog {
  level:"debug"|"info"|"warning"|"error";
  message:string;
  data?:Record<string,unknown>;
}

export interface RuntimeMetrics {
  [name:string]:number;
}

export interface RuntimeProbe {
  start(sceneId:string,seed:number):Promise<void>;
  stop():Promise<void>;
  input(event:RuntimeInput):Promise<void>;
  wait(milliseconds:number):Promise<void>;
  snapshot():Promise<RuntimeSnapshot>;
  logs():Promise<RuntimeLog[]>;
  captureFrame():Promise<Uint8Array>;
  metrics():Promise<RuntimeMetrics>;
}

export type AcceptanceStep =
  | {type:"runtime.start";sceneId:string}
  | {type:"runtime.stop"}
  | ({type:"input"}&RuntimeInput)
  | {type:"wait";milliseconds:number}
  | {type:"assert.equal";path:string;expected:unknown}
  | {type:"assert.near";path:string;expected:number;tolerance:number}
  | {type:"assert.logAbsent";minimumLevel:"warning"|"error";messageIncludes?:string}
  | {type:"assert.metricMax";metric:string;max:number}
  | {type:"assert.metricMin";metric:string;min:number}
  | {type:"assert.screenshotSha256";sha256:string};

export interface AcceptanceManifest {
  schemaVersion:1;
  suite:string;
  seed:number;
  target:"runtime"|"packaged";
  steps:AcceptanceStep[];
}

export interface StepResult {
  index:number;
  type:AcceptanceStep["type"];
  passed:boolean;
  durationMs:number;
  message?:string;
}

export interface AcceptanceReport {
  suite:string;
  target:AcceptanceManifest["target"];
  passed:boolean;
  startedAt:string;
  finishedAt:string;
  steps:StepResult[];
}
