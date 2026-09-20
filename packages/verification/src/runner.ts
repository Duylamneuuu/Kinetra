import { createHash } from "node:crypto";
import type {
  AcceptanceManifest,
  AcceptanceReport,
  AcceptanceStep,
  RuntimeLog,
  RuntimeProbe,
  StepResult,
} from "./types.js";

function getPath(root:unknown,path:string):unknown{
  if(path.trim()==="") return root;
  let value:unknown=root;
  for(const segment of path.split(".")){
    if(typeof value!=="object"||value===null){
      throw new Error(`Cannot read "${path}": "${segment}" traverses non-object data`);
    }
    value=(value as Record<string,unknown>)[segment];
  }
  return value;
}

function stableEqual(a:unknown,b:unknown):boolean{
  return JSON.stringify(a)===JSON.stringify(b);
}

function severity(level:RuntimeLog["level"]):number{
  return{debug:0,info:1,warning:2,error:3}[level];
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function isValidPng(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false;
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== PNG_MAGIC[i]) return false;
  }
  return true;
}

export class StepAssertionError extends Error {
  constructor(
    message: string,
    public readonly expected?: unknown,
    public readonly actual?: unknown,
  ) {
    super(message);
    this.name = "StepAssertionError";
  }
}

async function executeStep(
  probe:RuntimeProbe,
  step:AcceptanceStep,
  seed:number,
):Promise<string|undefined>{
  switch(step.type){
    case "runtime.start":
      if (step.assets && typeof probe.registerAsset === "function") {
        for (const [assetId, dataBase64] of Object.entries(step.assets)) {
          await probe.registerAsset(assetId, dataBase64);
        }
      }
      await probe.start(step.sceneId, seed);
      return;
    case "asset.register":
      if (typeof probe.registerAsset === "function") {
        await probe.registerAsset(step.assetId, step.dataBase64);
      }
      return;
    case "runtime.stop":
      await probe.stop();
      return;
    case "runtime.step":
      if (typeof probe.step === "function") {
        await probe.step(step.steps, step.deltaSeconds);
      } else {
        const ms = Math.round((step.steps ?? 1) * (step.deltaSeconds ?? 1 / 60) * 1000);
        await probe.wait(ms);
      }
      return;
    case "navigation.bake":
      if (typeof probe.bakeNavigation === "function") {
        await probe.bakeNavigation({
          ...(step.positions !== undefined ? { positions: step.positions } : {}),
          ...(step.indices !== undefined ? { indices: step.indices } : {}),
          ...(step.config !== undefined ? { config: step.config } : {}),
        });
      }
      return;
    case "animation.play":
      if (typeof probe.playAnimation === "function") {
        await probe.playAnimation(step.entityId, step.clip, {
          ...(step.loop !== undefined ? { loop: step.loop } : {}),
        });
      }
      return;
    case "animation.stop":
      if (typeof probe.stopAnimation === "function") {
        await probe.stopAnimation(step.entityId);
      }
      return;
    case "audio.play":
      if (typeof probe.playAudio === "function") {
        await probe.playAudio({
          assetId: step.assetId,
          ...(step.bus !== undefined ? { bus: step.bus } : {}),
          ...(step.loop !== undefined ? { loop: step.loop } : {}),
          ...(step.gain !== undefined ? { gain: step.gain } : {}),
          ...(step.entityId !== undefined ? { entityId: step.entityId } : {}),
        });
      }
      return;
    case "audio.stop":
      if (typeof probe.stopAudio === "function") {
        await probe.stopAudio({
          ...(step.playbackId !== undefined ? { playbackId: step.playbackId } : {}),
          ...(step.entityId !== undefined ? { entityId: step.entityId } : {}),
        });
      }
      return;
    case "audio.setBusGain":
      if (typeof probe.setAudioBusGain === "function") {
        await probe.setAudioBusGain(step.busId, step.gain);
      }
      return;
    case "audio.setBusMuted":
      if (typeof probe.setAudioBusMuted === "function") {
        await probe.setAudioBusMuted(step.busId, step.muted);
      }
      return;
    case "navigation.load":
      if (typeof probe.loadNavigation === "function") {
        await probe.loadNavigation({
          dataBase64: step.dataBase64,
        });
      }
      return;
    case "navigation.closestPoint":
      if (typeof probe.closestPointNavigation === "function") {
        await probe.closestPointNavigation({
          position: step.position,
          ...(step.halfExtents !== undefined
            ? { halfExtents: step.halfExtents }
            : {}),
        });
      }
      return;
    case "navigation.computePath":
      if (typeof probe.computePathNavigation === "function") {
        await probe.computePathNavigation({
          start: step.start,
          end: step.end,
          ...(step.halfExtents !== undefined
            ? { halfExtents: step.halfExtents }
            : {}),
        });
      }
      return;
    case "save.capture":
      if (typeof probe.captureSave === "function") {
        await probe.captureSave(step.slotId);
      }
      return;
    case "save.load":
      if (typeof probe.loadSave === "function") {
        await probe.loadSave({
          ...(step.slotId !== undefined ? { slotId: step.slotId } : {}),
          ...(step.envelope !== undefined ? { envelope: step.envelope } : {}),
        });
      }
      return;
    case "input":
      await probe.input({
        action:step.action,
        phase:step.phase,
        ...(step.value!==undefined?{value:step.value}:{}),
        ...(step.durationMs!==undefined?{durationMs:step.durationMs}:{}),
      });
      return;
    case "wait":
      if(step.milliseconds<0) throw new Error("wait milliseconds must be >= 0");
      await probe.wait(step.milliseconds);
      return;
    case "assert.equal":{
      const snapshot=await probe.snapshot();
      const actual=getPath(snapshot,step.path);
      if(!stableEqual(actual,step.expected)){
        throw new StepAssertionError(
          `Expected ${step.path} = ${JSON.stringify(step.expected)}, got ${JSON.stringify(actual)}`,
          step.expected,
          actual,
        );
      }
      return;
    }
    case "assert.near":{
      const actual=getPath(await probe.snapshot(),step.path);
      if(typeof actual!=="number"){
        throw new StepAssertionError(
          `Expected numeric value at ${step.path}`,
          step.expected,
          actual,
        );
      }
      if(Math.abs(actual-step.expected)>step.tolerance){
        throw new StepAssertionError(
          `Expected ${step.path} near ${step.expected} ± ${step.tolerance}, got ${actual}`,
          step.expected,
          actual,
        );
      }
      return;
    }
    case "assert.logAbsent":{
      const minimum=severity(step.minimumLevel);
      const offending=(await probe.logs()).find(log=>
        severity(log.level)>=minimum &&
        (step.messageIncludes===undefined||log.message.includes(step.messageIncludes))
      );
      if(offending){
        throw new StepAssertionError(
          `Unexpected ${offending.level} log: ${offending.message}`,
          `no logs with level >= ${step.minimumLevel}${step.messageIncludes ? ` containing "${step.messageIncludes}"` : ""}`,
          `[${offending.level}] ${offending.message}`,
        );
      }
      return;
    }
    case "assert.metricMax":{
      const value=(await probe.metrics())[step.metric];
      if(value===undefined) throw new StepAssertionError(`Metric "${step.metric}" is unavailable`, step.max, undefined);
      if(value>step.max) throw new StepAssertionError(`Metric "${step.metric}" = ${value} exceeds max ${step.max}`, step.max, value);
      return;
    }
    case "assert.metricMin":{
      const value=(await probe.metrics())[step.metric];
      if(value===undefined) throw new StepAssertionError(`Metric "${step.metric}" is unavailable`, step.min, undefined);
      if(value<step.min) throw new StepAssertionError(`Metric "${step.metric}" = ${value} is below min ${step.min}`, step.min, value);
      return;
    }
    case "assert.screenshotSha256":{
      const actual=createHash("sha256").update(await probe.captureFrame()).digest("hex");
      if(actual!==step.sha256){
        throw new StepAssertionError(
          `Screenshot hash mismatch: expected ${step.sha256}, got ${actual}`,
          step.sha256,
          actual,
        );
      }
      return;
    }
    case "assert.screenshotValidPng":{
      const bytes=await probe.captureFrame();
      const minBytes=step.minBytes??1_000;
      if(bytes.length<minBytes){
        throw new StepAssertionError(
          `Screenshot too small: expected at least ${minBytes} bytes, got ${bytes.length}`,
          minBytes,
          bytes.length,
        );
      }
      if(!isValidPng(bytes)){
        throw new StepAssertionError(
          "Screenshot is not a valid PNG (missing PNG magic header)",
          "valid PNG magic header",
          bytes.length >= 8 ? Array.from(bytes.slice(0, 8)).map((b) => b.toString(16).padStart(2, "0")).join(" ") : "truncated",
        );
      }
      return;
    }
  }
}

export class AcceptanceRunner {
  constructor(private readonly probe:RuntimeProbe){}

  async run(manifest:AcceptanceManifest):Promise<AcceptanceReport>{
    if(manifest.schemaVersion!==1) throw new Error("Unsupported acceptance manifest schema");
    const started=new Date();
    const startedPerf=performance.now();
    const steps:StepResult[]=[];
    let runtimeStarted=false;

    try{
      for(let index=0;index<manifest.steps.length;index++){
        const step=manifest.steps[index]!;
        const before=performance.now();
        try{
          if(step.type==="runtime.start"){
            runtimeStarted=true;
          }else if(step.type==="runtime.stop"){
            runtimeStarted=false;
          }
          await executeStep(this.probe,step,manifest.seed);
          steps.push({
            index,type:step.type,passed:true,
            durationMs:performance.now()-before,
          });
        }catch(error){
          const message=error instanceof Error?error.message:String(error);
          const isAssertion=error instanceof StepAssertionError;
          const expected=isAssertion?error.expected:("expected" in step?step.expected:undefined);
          const actual=isAssertion?error.actual:undefined;
          steps.push({
            index,
            type:step.type,
            passed:false,
            durationMs:performance.now()-before,
            message,
            error:message,
            ...(expected!==undefined?{expected}:{}),
            ...(actual!==undefined?{actual}:{}),
          });
          break;
        }
      }
    }finally{
      if(runtimeStarted){
        try{
          await this.probe.stop();
        }catch{
          // Clean teardown on failure
        }
      }
    }

    const finished=new Date();
    const durationMs=performance.now()-startedPerf;
    const failedSteps=steps.filter((step)=>!step.passed);
    const failureReason=failedSteps.length>0?failedSteps[0]?.message:undefined;

    return{
      suite:manifest.suite,
      target:manifest.target,
      passed:steps.length===manifest.steps.length&&steps.every(step=>step.passed),
      durationMs,
      startedAt:started.toISOString(),
      finishedAt:finished.toISOString(),
      steps,
      failedSteps,
      ...(failureReason!==undefined?{failureReason}:{}),
      observations:{
        totalSteps:manifest.steps.length,
        executedSteps:steps.length,
        target:manifest.target,
      },
    };
  }
}
