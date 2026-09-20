import type { ProjectDocument } from "@kinetra/project-model";

export interface RuntimeInput {
  action:string;
  phase:"press"|"release"|"hold";
  value?:number|[number,number];
  durationMs?:number;
}

export interface RuntimeSnapshot {
  running:boolean;
  sceneId?:string|undefined;
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

export interface RuntimeProbeHost {
  start(
    project: ProjectDocument,
    sceneId: string,
    projectRevision: number,
    assets?: Record<string, string>,
  ): Promise<void>;
  stop(): Promise<void>;
  close?(): Promise<void>;
  registerAsset?(assetId: string, dataBase64: string): Promise<void>;
  query(query?: { entityIds?: string[] }): Promise<{
    running: boolean;
    sceneId?: string;
    projectRevision?: number;
    entities: Array<{
      entityId: string;
      name: string;
      objectType: string;
      parentEntityId?: string;
      position: [number, number, number];
      rotation: [number, number, number];
      scale: [number, number, number];
      model?: {
        assetId: string;
        loaded: boolean;
        meshCount: number;
        nodeCount: number;
        bounds?: {
          min: [number, number, number];
          max: [number, number, number];
          size: [number, number, number];
        };
        animation?: {
          clips: Array<{ name: string; duration: number }>;
          activeClip?: string;
          playing: boolean;
          time: number;
          duration?: number;
        };
        nodes?: Array<{
          name: string;
          position: [number, number, number];
          rotation?: [number, number, number, number];
          scale?: [number, number, number];
        }>;
        error?: string;
      };
      gameplay?: {
        scriptId: string;
        lifecycleState: string;
        updateCount: number;
        state?: Record<string, unknown>;
        error?: string;
      };
    }>;
    navigation?: Record<string, unknown>;
  }>;
  injectInput(event: {
    action: string;
    phase: "press" | "release" | "hold";
    value?: number | [number, number];
    durationMs?: number;
  }): Promise<void>;
  captureFrame(): Promise<{
    available: boolean;
    mimeType?: string;
    base64?: string;
    reason?: string;
  }>;
  readLogs(sinceSequence?: number): Promise<Array<{
    sequence: number;
    level: "debug" | "info" | "warning" | "error";
    message: string;
    data?: Record<string, unknown>;
  }>>;
  step?(steps?: number, deltaSeconds?: number): Promise<unknown>;
  bakeNavigation?(params: {
    positions?: number[];
    indices?: number[];
    config?: Record<string, unknown>;
  }): Promise<unknown>;
  loadNavigation?(params: { dataBase64: string }): Promise<unknown>;
  closestPointNavigation?(params: {
    position: [number, number, number];
    halfExtents?: [number, number, number];
  }): Promise<unknown>;
  computePathNavigation?(params: {
    start: [number, number, number];
    end: [number, number, number];
    halfExtents?: [number, number, number];
  }): Promise<unknown>;
  playAnimation?(entityId: string, clip: string, options?: { loop?: boolean }): Promise<unknown>;
  stopAnimation?(entityId: string): Promise<unknown>;
  captureSave?(slotId?: string): Promise<{ success: boolean; envelope?: Record<string, unknown>; error?: string }>;
  getSave?(slotId?: string): Promise<{ success: boolean; envelope?: Record<string, unknown>; error?: string }>;
  loadSave?(params: { slotId?: string; envelope?: Record<string, unknown> }): Promise<{ success: boolean; slotId?: string; schemaVersion?: number; error?: string }>;
  enableTestScriptFixtures?(preset: string): Promise<void>;
}

export interface RuntimeProbe {
  start(sceneId:string,seed:number):Promise<void>;
  stop():Promise<void>;
  input(event:RuntimeInput):Promise<void>;
  wait(milliseconds:number):Promise<void>;
  step?(steps?: number, deltaSeconds?: number): Promise<void>;
  snapshot():Promise<RuntimeSnapshot>;
  logs():Promise<RuntimeLog[]>;
  captureFrame():Promise<Uint8Array>;
  metrics():Promise<RuntimeMetrics>;
  close?():Promise<void>;
  bakeNavigation?(params: {
    positions?: number[];
    indices?: number[];
    config?: Record<string, unknown>;
  }): Promise<void>;
  loadNavigation?(params: { dataBase64: string }): Promise<void>;
  closestPointNavigation?(params: {
    position: [number, number, number];
    halfExtents?: [number, number, number];
  }): Promise<void>;
  registerAsset?(assetId: string, dataBase64: string): Promise<void>;
  computePathNavigation?(params: {
    start: [number, number, number];
    end: [number, number, number];
    halfExtents?: [number, number, number];
  }): Promise<void>;
  playAnimation?(entityId: string, clip: string, options?: { loop?: boolean }): Promise<void>;
  stopAnimation?(entityId: string): Promise<void>;
  captureSave?(slotId?: string): Promise<{ success: boolean; envelope?: Record<string, unknown>; error?: string }>;
  getSave?(slotId?: string): Promise<{ success: boolean; envelope?: Record<string, unknown>; error?: string }>;
  loadSave?(params: { slotId?: string; envelope?: Record<string, unknown> }): Promise<{ success: boolean; slotId?: string; schemaVersion?: number; error?: string }>;
}

export type AcceptanceStep =
  | { type: "runtime.start"; sceneId: string; assets?: Record<string, string> }
  | { type: "runtime.stop" }
  | { type: "runtime.step"; steps?: number; deltaSeconds?: number }
  | { type: "asset.register"; assetId: string; dataBase64: string }
  | { type: "animation.play"; entityId: string; clip: string; loop?: boolean }
  | { type: "animation.stop"; entityId: string }
  | {
      type: "navigation.bake";
      positions?: number[];
      indices?: number[];
      config?: Record<string, unknown>;
    }
  | { type: "navigation.load"; dataBase64: string }
  | {
      type: "navigation.closestPoint";
      position: [number, number, number];
      halfExtents?: [number, number, number];
    }
  | {
      type: "navigation.computePath";
      start: [number, number, number];
      end: [number, number, number];
      halfExtents?: [number, number, number];
    }
  | { type: "save.capture"; slotId?: string }
  | { type: "save.load"; slotId?: string; envelope?: Record<string, unknown> }
  | ({type:"input"}&RuntimeInput)
  | {type:"wait";milliseconds:number}
  | {type:"assert.equal";path:string;expected:unknown}
  | {type:"assert.near";path:string;expected:number;tolerance:number}
  | {type:"assert.logAbsent";minimumLevel:"warning"|"error";messageIncludes?:string}
  | {type:"assert.metricMax";metric:string;max:number}
  | {type:"assert.metricMin";metric:string;min:number}
  | {type:"assert.screenshotSha256";sha256:string}
  | {type:"assert.screenshotValidPng";minBytes?:number};

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
