import { z } from "zod";
import type { ProjectDocument } from "@kinetra/project-model";
import type { VisualFrameEvidence, VisualComparison } from "./visual.js";
import type { VisualCritiqueReport } from "./critique.js";
import type { RuntimePerformanceEvidence, PerformanceBudgetViolation } from "./performance.js";

export interface RuntimeInput {
  action:string;
  phase:"press"|"release"|"hold";
  value?:number|[number,number];
  durationMs?:number;
}

export interface RuntimeSnapshot {
  running: boolean;
  sceneId?: string | undefined;
  state: Record<string, unknown>;
  shell?: { mode: string; isPaused: boolean };
  renderer?: {
    captureMode: "performance" | "visual";
    preserveDrawingBuffer: boolean;
  };
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
    options?: {
      assetMetadata?: Record<string, { fingerprint?: string; sourceHash?: string }>;
      stepped?: boolean;
    },
  ): Promise<void>;
  stop(): Promise<void>;
  close?(): Promise<void>;
  registerAsset?(
    assetId: string,
    dataBase64: string,
    options?: { fingerprint?: string; sourceHash?: string },
  ): Promise<void>;
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
        skinnedMeshCount?: number;
        hasSkin?: boolean;
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
        instance?: {
          assetId: string;
          instanceId: string;
          sharedTemplateId: string;
          skinnedMeshCount: number;
          skeletonCount: number;
          fingerprint?: string;
          templateRevision?: number;
        };
        resourceSharing?: {
          templateRefCount: number;
        };
        assetFingerprint?: string;
        templateRevision?: number;
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
    audio?: Record<string, unknown>;
    gameplay?: Record<string, unknown>;
    game?: Record<string, unknown>;
    shell?: { mode: string; isPaused: boolean };
    metrics?: Record<string, number>;
    renderer?: {
      captureMode: "performance" | "visual";
      preserveDrawingBuffer: boolean;
    };
    assets?: {
      byId: Record<
        string,
        {
          assetId: string;
          sourceHash?: string;
          fingerprint?: string;
          importStatus: string;
          revision?: number;
          dependentIds?: string[];
          error?: string;
        }
      >;
    };
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
  playAnimation?(
    entityId: string,
    clip: string,
    options?: {
      loop?: boolean;
      retargetSource?: string;
      retargetCacheKey?: string;
    },
  ): Promise<unknown>;
  registerAnimationClip?(entityId: string, clip: unknown): Promise<unknown>;
  stopAnimation?(entityId: string): Promise<unknown>;
  playAudio?(params: {
    assetId: string;
    bus?: string;
    loop?: boolean;
    gain?: number;
    entityId?: string;
  }): Promise<unknown>;
  stopAudio?(params?: { playbackId?: string; entityId?: string }): Promise<unknown>;
  setAudioBusGain?(busId: string, gain: number): Promise<unknown>;
  setAudioBusMuted?(busId: string, muted: boolean): Promise<unknown>;
  captureSave?(slotId?: string): Promise<{ success: boolean; envelope?: Record<string, unknown>; error?: string }>;
  getSave?(slotId?: string): Promise<{ success: boolean; envelope?: Record<string, unknown>; error?: string }>;
  loadSave?(params: { slotId?: string; envelope?: Record<string, unknown> }): Promise<{ success: boolean; slotId?: string; schemaVersion?: number; error?: string }>;
  pause?(): Promise<unknown>;
  resume?(): Promise<unknown>;
  enableTestScriptFixtures?(preset: string): Promise<void>;
  detachModel?(entityId: string): Promise<unknown>;
  attachModel?(entityId: string, assetId: string): Promise<unknown>;
  reloadAsset?(assetId: string): Promise<{ success: boolean; affectedEntities: string[]; error?: string }>;
  updateAsset?(
    assetId: string,
    dataBase64: string,
    options?: { fingerprint?: string; sourceHash?: string },
  ): Promise<unknown>;
  samplePerformance?(options?: {
    warmupFrames?: number;
    sampleFrames?: number;
    fixedDeltaSeconds?: number;
    mode?: "stepped" | "continuous";
  }): Promise<RuntimePerformanceEvidence>;
}


export interface RuntimeProbe {
  start(sceneId:string,seed:number):Promise<void>;
  stop():Promise<void>;
  pause?():Promise<void>;
  resume?():Promise<void>;
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
  registerAsset?(
    assetId: string,
    dataBase64: string,
    options?: { fingerprint?: string; sourceHash?: string },
  ): Promise<void>;
  updateAsset?(
    assetId: string,
    dataBase64: string,
    options?: { fingerprint?: string; sourceHash?: string },
  ): Promise<void>;
  reloadAsset?(assetId: string): Promise<{ success: boolean; affectedEntities: string[]; error?: string }>;
  computePathNavigation?(params: {
    start: [number, number, number];
    end: [number, number, number];
    halfExtents?: [number, number, number];
  }): Promise<void>;
  playAnimation?(
    entityId: string,
    clip: string,
    options?: {
      loop?: boolean;
      retargetSource?: string;
      retargetCacheKey?: string;
    },
  ): Promise<void>;
  registerAnimationClip?(entityId: string, clip: unknown): Promise<void>;
  stopAnimation?(entityId: string): Promise<void>;
  playAudio?(params: {
    assetId: string;
    bus?: string;
    loop?: boolean;
    gain?: number;
    entityId?: string;
  }): Promise<void>;
  stopAudio?(params?: { playbackId?: string; entityId?: string }): Promise<void>;
  setAudioBusGain?(busId: string, gain: number): Promise<void>;
  setAudioBusMuted?(busId: string, muted: boolean): Promise<void>;
  captureSave?(slotId?: string): Promise<{ success: boolean; envelope?: Record<string, unknown>; error?: string }>;
  getSave?(slotId?: string): Promise<{ success: boolean; envelope?: Record<string, unknown>; error?: string }>;
  loadSave?(params: { slotId?: string; envelope?: Record<string, unknown> }): Promise<{ success: boolean; slotId?: string; schemaVersion?: number; error?: string }>;
  samplePerformance?(options?: {
    warmupFrames?: number;
    sampleFrames?: number;
    fixedDeltaSeconds?: number;
    mode?: "stepped" | "continuous";
  }): Promise<RuntimePerformanceEvidence>;
}

export const runtimeStartStepSchema = z.object({
  type: z.literal("runtime.start"),
  sceneId: z.string().min(1),
  assets: z.record(z.string(), z.string()).optional(),
}).strict();

export const runtimeStopStepSchema = z.object({
  type: z.literal("runtime.stop"),
}).strict();

export const runtimePauseStepSchema = z.object({
  type: z.literal("runtime.pause"),
}).strict();

export const runtimeResumeStepSchema = z.object({
  type: z.literal("runtime.resume"),
}).strict();

export const runtimeStepStepSchema = z.object({
  type: z.literal("runtime.step"),
  steps: z.number().int().positive().optional(),
  deltaSeconds: z.number().positive().optional(),
}).strict();

export const assetRegisterStepSchema = z.object({
  type: z.literal("asset.register"),
  assetId: z.string().min(1),
  dataBase64: z.string().min(1),
}).strict();

export const animationPlayStepSchema = z.object({
  type: z.literal("animation.play"),
  entityId: z.string().min(1),
  clip: z.string().min(1),
  loop: z.boolean().optional(),
}).strict();

export const animationStopStepSchema = z.object({
  type: z.literal("animation.stop"),
  entityId: z.string().min(1),
}).strict();

export const audioPlayStepSchema = z.object({
  type: z.literal("audio.play"),
  assetId: z.string().min(1),
  bus: z.string().min(1).optional(),
  loop: z.boolean().optional(),
  gain: z.number().optional(),
  entityId: z.string().min(1).optional(),
}).strict();

export const audioStopStepSchema = z.object({
  type: z.literal("audio.stop"),
  playbackId: z.string().min(1).optional(),
  entityId: z.string().min(1).optional(),
}).strict();

export const audioSetBusGainStepSchema = z.object({
  type: z.literal("audio.setBusGain"),
  busId: z.string().min(1),
  gain: z.number(),
}).strict();

export const audioSetBusMutedStepSchema = z.object({
  type: z.literal("audio.setBusMuted"),
  busId: z.string().min(1),
  muted: z.boolean(),
}).strict();

export const navigationBakeStepSchema = z.object({
  type: z.literal("navigation.bake"),
  positions: z.array(z.number()).optional(),
  indices: z.array(z.number()).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const navigationLoadStepSchema = z.object({
  type: z.literal("navigation.load"),
  dataBase64: z.string().min(1),
}).strict();

export const navigationClosestPointStepSchema = z.object({
  type: z.literal("navigation.closestPoint"),
  position: z.tuple([z.number(), z.number(), z.number()]),
  halfExtents: z.tuple([z.number(), z.number(), z.number()]).optional(),
}).strict();

export const navigationComputePathStepSchema = z.object({
  type: z.literal("navigation.computePath"),
  start: z.tuple([z.number(), z.number(), z.number()]),
  end: z.tuple([z.number(), z.number(), z.number()]),
  halfExtents: z.tuple([z.number(), z.number(), z.number()]).optional(),
}).strict();

export const saveCaptureStepSchema = z.object({
  type: z.literal("save.capture"),
  slotId: z.string().min(1).optional(),
}).strict();

export const saveLoadStepSchema = z.object({
  type: z.literal("save.load"),
  slotId: z.string().min(1).optional(),
  envelope: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const inputStepSchema = z.object({
  type: z.literal("input"),
  action: z.string().min(1),
  phase: z.enum(["press", "release", "hold"]),
  value: z.union([z.number(), z.tuple([z.number(), z.number()])]).optional(),
  durationMs: z.number().nonnegative().optional(),
}).strict();

export const waitStepSchema = z.object({
  type: z.literal("wait"),
  milliseconds: z.number().nonnegative(),
}).strict();

export const assertEqualStepSchema = z.object({
  type: z.literal("assert.equal"),
  path: z.string().min(1),
  expected: z.unknown(),
}).strict();

export const assertNearStepSchema = z.object({
  type: z.literal("assert.near"),
  path: z.string().min(1),
  expected: z.number(),
  tolerance: z.number().nonnegative(),
}).strict();

export const assertLogAbsentStepSchema = z.object({
  type: z.literal("assert.logAbsent"),
  minimumLevel: z.enum(["warning", "error"]),
  messageIncludes: z.string().optional(),
}).strict();

export const assertMetricMaxStepSchema = z.object({
  type: z.literal("assert.metricMax"),
  metric: z.string().min(1),
  max: z.number(),
}).strict();

export const assertMetricMinStepSchema = z.object({
  type: z.literal("assert.metricMin"),
  metric: z.string().min(1),
  min: z.number(),
}).strict();

export const assertScreenshotSha256StepSchema = z.object({
  type: z.literal("assert.screenshotSha256"),
  sha256: z.string().min(1),
}).strict();

export const assertScreenshotValidPngStepSchema = z.object({
  type: z.literal("assert.screenshotValidPng"),
  minBytes: z.number().int().positive().optional(),
}).strict();

export const captureFrameStepSchema = z.object({
  type: z.literal("capture.frame"),
  id: z.string().min(1),
  saveArtifact: z.boolean().optional(),
}).strict();

export const assertVisualNotBlankStepSchema = z.object({
  type: z.literal("assert.visualNotBlank"),
  captureId: z.string().min(1).optional(),
  minOpaqueRatio: z.number().min(0).max(1).optional(),
  minLuminanceVariance: z.number().min(0).optional(),
  minEntropy: z.number().min(0).optional(),
}).strict();

export const assertVisualSimilarityStepSchema = z.object({
  type: z.literal("assert.visualSimilarity"),
  referenceCaptureId: z.string().min(1),
  actualCaptureId: z.string().min(1).optional(),
  maxChangedPixelRatio: z.number().min(0).max(1).optional(),
  maxPerceptualHashDistance: z.number().int().min(0).max(64).optional(),
  maxMeanAbsoluteDifference: z.number().min(0).max(1).optional(),
  // RGB absolute-sum difference per pixel: 3 channels x 255 = 765 is the maximum.
  pixelDiffThreshold: z.number().int().min(0).max(765).optional(),
}).strict();

export const assertVisualDifferenceStepSchema = z.object({
  type: z.literal("assert.visualDifference"),
  referenceCaptureId: z.string().min(1),
  actualCaptureId: z.string().min(1).optional(),
  minChangedPixelRatio: z.number().min(0).max(1).optional(),
  minPerceptualHashDistance: z.number().int().min(0).max(64).optional(),
}).strict();

export const critiqueVisualStepSchema = z.object({
  type: z.literal("critique.visual"),
  captureId: z.string().min(1).optional(),
  rubric: z.string().min(1),
  expectedVisualFacts: z.array(z.string()).optional(),
  requireProvider: z.boolean().optional(),
}).strict();

export const performanceSampleStepSchema = z.object({
  type: z.literal("performance.sample"),
  warmupFrames: z.number().int().min(0).optional(),
  sampleFrames: z.number().int().min(1).optional(),
  fixedDeltaSeconds: z.number().positive().optional(),
  mode: z.enum(["stepped", "continuous"]).optional(),
}).strict();

const performanceThresholdSchema = z.union([
  z.number(),
  z.object({
    max: z.number().optional(),
    min: z.number().optional(),
  }).strict(),
]);

export const assertPerformanceBudgetStepSchema = z.object({
  type: z.literal("assert.performanceBudget"),
  profile: z.string().optional(),
  budget: z.union([
    z.record(z.string(), performanceThresholdSchema),
    z.object({
      profile: z.string().optional(),
      budgets: z.record(z.string(), performanceThresholdSchema).optional(),
      windows: z.record(z.string(), performanceThresholdSchema).optional(),
      linux: z.record(z.string(), performanceThresholdSchema).optional(),
    }).passthrough(),
  ]).optional(),
  budgets: z.record(z.string(), performanceThresholdSchema).optional(),
  windows: z.record(z.string(), performanceThresholdSchema).optional(),
  linux: z.record(z.string(), performanceThresholdSchema).optional(),
}).strict();

export const acceptanceStepSchema = z.discriminatedUnion("type", [
  runtimeStartStepSchema,
  runtimeStopStepSchema,
  runtimePauseStepSchema,
  runtimeResumeStepSchema,
  runtimeStepStepSchema,
  assetRegisterStepSchema,
  animationPlayStepSchema,
  animationStopStepSchema,
  audioPlayStepSchema,
  audioStopStepSchema,
  audioSetBusGainStepSchema,
  audioSetBusMutedStepSchema,
  navigationBakeStepSchema,
  navigationLoadStepSchema,
  navigationClosestPointStepSchema,
  navigationComputePathStepSchema,
  saveCaptureStepSchema,
  saveLoadStepSchema,
  inputStepSchema,
  waitStepSchema,
  assertEqualStepSchema,
  assertNearStepSchema,
  assertLogAbsentStepSchema,
  assertMetricMaxStepSchema,
  assertMetricMinStepSchema,
  assertScreenshotSha256StepSchema,
  assertScreenshotValidPngStepSchema,
  captureFrameStepSchema,
  assertVisualNotBlankStepSchema,
  assertVisualSimilarityStepSchema,
  assertVisualDifferenceStepSchema,
  critiqueVisualStepSchema,
  performanceSampleStepSchema,
  assertPerformanceBudgetStepSchema,
]);

export type AcceptanceStep = z.infer<typeof acceptanceStepSchema>;

export const acceptanceManifestSchema = z.object({
  schemaVersion: z.literal(1),
  suite: z.string().min(1),
  seed: z.number().int().default(0),
  target: z.enum(["runtime", "packaged"]).default("runtime"),
  steps: z.array(acceptanceStepSchema),
}).strict();

export type AcceptanceManifest = z.infer<typeof acceptanceManifestSchema>;
export type AcceptanceManifestInput = z.input<typeof acceptanceManifestSchema>;

export interface MissingPathDiagnostic {
  kind: "missing_path";
  path: string;
  missingSegment: string;
  availableKeys: string[];
}

/**
 * A visual helper rejected its input (undecodable PNG, invalid threshold,
 * malformed image). `code` is the `VisualError.code` so agents can branch on
 * it; `details` carries the structured context the helper attached.
 */
export interface VisualErrorInfo {
  code: string;
  details: Record<string, unknown>;
}

export interface StepResult {
  index: number;
  type: AcceptanceStep["type"];
  passed: boolean;
  durationMs: number;
  message?: string | undefined;
  error?: string | undefined;
  expected?: unknown | undefined;
  actual?: unknown | undefined;
  diagnostics?: MissingPathDiagnostic | undefined;
  visualError?: VisualErrorInfo | undefined;
  visualEvidence?: VisualFrameEvidence | undefined;
  visualComparison?: VisualComparison | undefined;
  critiqueReport?: VisualCritiqueReport | undefined;
  performanceEvidence?: RuntimePerformanceEvidence | undefined;
  performanceViolations?: PerformanceBudgetViolation[] | undefined;
}

export interface AcceptanceReport {
  suite:string;
  target:AcceptanceManifest["target"];
  passed:boolean;
  durationMs?:number;
  startedAt:string;
  finishedAt:string;
  steps:StepResult[];
  failedSteps?:StepResult[];
  failureReason?:string;
  observations?:Record<string,unknown>;
}
