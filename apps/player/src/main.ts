import type { ProjectDocument } from "@kinetra/project-model";
import {
  createArenaProject,
  ARENA_SCENE_ID,
  arenaAudioAssets,
} from "@kinetra/reference-game";

import { SettingsStore } from "@kinetra/save-state";
import { PlayerRuntimeController } from "./runtime-controller.js";
import { GameShellController } from "./shell.js";
import "./style.css";

const canvas = document.querySelector<HTMLCanvasElement>("#game");
const status = document.querySelector<HTMLSpanElement>("#status");
const fullscreenButton =
  document.querySelector<HTMLButtonElement>("#fullscreen");

if (!canvas || !status || !fullscreenButton) {
  throw new Error("Kinetra player bootstrap DOM is incomplete");
}

const statusElement = status;
const searchParams = new URLSearchParams(window.location.search);
const captureModeParam = searchParams.get("captureMode");
const captureMode = captureModeParam === "visual" ? "visual" : "performance";
const runtime = new PlayerRuntimeController(canvas, { captureMode });
const settingsStore = new SettingsStore(runtime.getStorage());
const shell = new GameShellController(runtime, settingsStore);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function requireRevision(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new TypeError("projectRevision must be a non-negative integer");
  }
  return value as number;
}

async function handleRuntimeCommand(request: {
  id: string;
  method: string;
  params?: unknown;
}): Promise<unknown> {
  const params = requireRecord(request.params ?? {}, "params");

  switch (request.method) {
    case "runtime.start": {
      const project = params.project as ProjectDocument;
      const sceneId = requireString(params.sceneId, "sceneId");
      const projectRevision = requireRevision(params.projectRevision);
      const assets = isRecord(params.assets)
        ? (params.assets as Record<string, string>)
        : undefined;
      const stepped =
        typeof params.stepped === "boolean"
          ? params.stepped
          : params.mode === "realtime"
            ? false
            : true;
      const testScriptPreset =
        typeof params.testScriptPreset === "string"
          ? params.testScriptPreset
          : undefined;
      const assetMetadata = isRecord(params.assetMetadata)
        ? (params.assetMetadata as Record<string, { fingerprint?: string; sourceHash?: string }>)
        : undefined;
      const result = await runtime.start(project, sceneId, projectRevision, {
        ...(assets !== undefined ? { assets } : {}),
        ...(assetMetadata !== undefined ? { assetMetadata } : {}),
        stepped,
        ...(testScriptPreset !== undefined ? { testScriptPreset } : {}),
      });
      shell.setMode("playing");
      shell.updateFromRuntime();
      statusElement.textContent =
        `agent runtime · scene ${sceneId} · revision ${projectRevision}`;
      return result;
    }

    case "asset.register": {
      const assetId = requireString(params.assetId, "assetId");
      const dataBase64 = requireString(params.dataBase64, "dataBase64");
      const fingerprint = typeof params.fingerprint === "string" ? params.fingerprint : undefined;
      const sourceHash = typeof params.sourceHash === "string" ? params.sourceHash : undefined;
      runtime.registerAsset(assetId, dataBase64, { fingerprint, sourceHash });
      return { registered: true, assetId };
    }

    case "asset.update": {
      const assetId = requireString(params.assetId, "assetId");
      const dataBase64 = requireString(params.dataBase64, "dataBase64");
      const fingerprint = typeof params.fingerprint === "string" ? params.fingerprint : undefined;
      const sourceHash = typeof params.sourceHash === "string" ? params.sourceHash : undefined;
      runtime.updateAsset(assetId, dataBase64, { fingerprint, sourceHash });
      return { updated: true, assetId, ...runtime.query() };
    }

    case "performance.sample": {
      const warmupFrames =
        typeof params.warmupFrames === "number" ? params.warmupFrames : undefined;
      const sampleFrames =
        typeof params.sampleFrames === "number" ? params.sampleFrames : undefined;
      const fixedDeltaSeconds =
        typeof params.fixedDeltaSeconds === "number"
          ? params.fixedDeltaSeconds
          : undefined;
      const mode = params.mode === "continuous" ? "continuous" : "stepped";
      return await runtime.samplePerformance({
        ...(warmupFrames !== undefined ? { warmupFrames } : {}),
        ...(sampleFrames !== undefined ? { sampleFrames } : {}),
        ...(fixedDeltaSeconds !== undefined ? { fixedDeltaSeconds } : {}),
        mode,
      });
    }

    case "shell.startRun": {
      const stepped =
        typeof params.stepped === "boolean"
          ? params.stepped
          : params.mode === "realtime"
            ? false
            : true;
      await shell.startArenaGame(false, { stepped });
      return runtime.query();
    }

    case "shell.continueRun": {
      const stepped =
        typeof params.stepped === "boolean"
          ? params.stepped
          : params.mode === "realtime"
            ? false
            : true;
      await shell.startArenaGame(true, { stepped });
      return runtime.query();
    }

    case "game.pause":
    case "runtime.pause": {
      runtime.pause();
      shell.setMode("paused");
      return runtime.query();
    }

    case "game.resume":
    case "runtime.resume": {
      runtime.resume();
      shell.setMode("playing");
      return runtime.query();
    }

    case "settings.get": {
      return shell.getSettings();
    }

    case "settings.set": {
      if (typeof params.masterGain === "number") {
        await shell.setMasterVolume(params.masterGain);
      }
      if (typeof params.sfxGain === "number") {
        await shell.setSfxVolume(params.sfxGain);
      }
      if (typeof params.fullscreen === "boolean") {
        await shell.setFullscreen(params.fullscreen);
      }
      if (typeof params.remapAction === "string" && Array.isArray(params.bindings)) {
        await shell.remapAction(params.remapAction, params.bindings as any);
      }
      return shell.getSettings();
    }

    case "runtime.step": {
      const steps = typeof params.steps === "number" ? params.steps : 1;
      const deltaSeconds =
        typeof params.deltaSeconds === "number" ? params.deltaSeconds : 1 / 60;
      runtime.step(steps, deltaSeconds);
      shell.updateFromRuntime();
      return runtime.query();
    }

    case "animation.play": {
      const entityId = requireString(params.entityId, "entityId");
      const clip = requireString(params.clip, "clip");
      const loop = typeof params.loop === "boolean" ? params.loop : undefined;
      const retargetSource =
        typeof params.retargetSource === "string" ? params.retargetSource : undefined;
      const retargetCacheKey =
        typeof params.retargetCacheKey === "string" ? params.retargetCacheKey : undefined;
      const result = runtime.playAnimation(entityId, clip, {
        ...(loop !== undefined ? { loop } : {}),
        ...(retargetSource !== undefined ? { retargetSource } : {}),
        ...(retargetCacheKey !== undefined ? { retargetCacheKey } : {}),
      });
      return { ...result, ...runtime.query() };
    }

    case "animation.crossfade": {
      const entityId = requireString(params.entityId, "entityId");
      const clip = requireString(params.clip, "clip");
      const blendSeconds = typeof params.blendSeconds === "number" ? params.blendSeconds : 0.15;
      const loop = typeof params.loop === "boolean" ? params.loop : undefined;
      const speed = typeof params.speed === "number" ? params.speed : undefined;
      const result = runtime.crossfadeAnimation(entityId, clip, blendSeconds, {
        ...(loop !== undefined ? { loop } : {}),
        ...(speed !== undefined ? { speed } : {}),
      });
      return { ...result, ...runtime.query() };
    }

    case "animation.graph.init": {
      const entityId = requireString(params.entityId, "entityId");
      const graph = params.graph as any;
      const result = runtime.initAnimationGraph(entityId, graph);
      return { ...result, ...runtime.query() };
    }

    case "animation.graph.setParameter": {
      const entityId = requireString(params.entityId, "entityId");
      const name = requireString(params.name, "name");
      const value = params.value as boolean | number;
      const result = runtime.setAnimationGraphParameter(entityId, name, value);
      return { ...result, ...runtime.query() };
    }

    case "animation.graph.trigger": {
      const entityId = requireString(params.entityId, "entityId");
      const name = requireString(params.name, "name");
      const result = runtime.triggerAnimationGraph(entityId, name);
      return { ...result, ...runtime.query() };
    }

    case "animation.graph.evaluate": {
      const entityId = requireString(params.entityId, "entityId");
      const result = runtime.evaluateAnimationGraph(entityId);
      return { ...result, ...runtime.query() };
    }

    case "animation.registerClip": {
      const entityId = requireString(params.entityId, "entityId");
      const clip = params.clip;
      const result = runtime.registerAnimationClip(entityId, clip);
      return { ...result, ...runtime.query() };
    }

    case "animation.stop": {
      const entityId = requireString(params.entityId, "entityId");
      runtime.stopAnimation(entityId);
      return runtime.query();
    }

    case "animation.rootMotion.configure": {
      const entityId = requireString(params.entityId, "entityId");
      const enabled = typeof params.enabled === "boolean" ? params.enabled : true;
      const mode = typeof params.mode === "string" ? (params.mode as any) : undefined;
      const rootBoneName = typeof params.rootBoneName === "string" ? params.rootBoneName : undefined;
      const result = runtime.configureRootMotion(entityId, {
        enabled,
        ...(mode !== undefined ? { mode } : {}),
        ...(rootBoneName !== undefined ? { rootBoneName } : {}),
      });
      return { ...result, ...runtime.query() };
    }

    case "model.detach": {
      const entityId = requireString(params.entityId, "entityId");
      const result = runtime.detachModel(entityId);
      return { ...result, ...runtime.query() };
    }

    case "model.attach": {
      const entityId = requireString(params.entityId, "entityId");
      const assetId = requireString(params.assetId, "assetId");
      const result = await runtime.attachModel(entityId, assetId);
      return { ...result, ...runtime.query() };
    }

    case "model.reloadAsset": {
      const assetId = requireString(params.assetId, "assetId");
      const result = await runtime.reloadAsset(assetId);
      return { ...result, ...runtime.query() };
    }

    case "audio.play": {

      const assetId = requireString(params.assetId, "assetId");
      const bus = typeof params.bus === "string" ? params.bus : undefined;
      const loop = typeof params.loop === "boolean" ? params.loop : undefined;
      const gain = typeof params.gain === "number" ? params.gain : undefined;
      const entityId =
        typeof params.entityId === "string" ? params.entityId : undefined;
      const result = await runtime.playAudio({
        assetId,
        ...(bus !== undefined ? { bus } : {}),
        ...(loop !== undefined ? { loop } : {}),
        ...(gain !== undefined ? { gain } : {}),
        ...(entityId !== undefined ? { entityId } : {}),
      });
      return { ...result, ...runtime.query() };
    }

    case "audio.stop": {
      const playbackId =
        typeof params.playbackId === "string" ? params.playbackId : undefined;
      const entityId =
        typeof params.entityId === "string" ? params.entityId : undefined;
      const result = runtime.stopAudio({
        ...(playbackId !== undefined ? { playbackId } : {}),
        ...(entityId !== undefined ? { entityId } : {}),
      });
      return { ...result, ...runtime.query() };
    }

    case "audio.setBusGain": {
      const busId = requireString(params.busId, "busId");
      if (typeof params.gain !== "number" || !Number.isFinite(params.gain)) {
        throw new TypeError("audio.setBusGain requires finite number gain");
      }
      runtime.setAudioBusGain(busId, params.gain);
      return runtime.query();
    }

    case "audio.setBusMuted": {
      const busId = requireString(params.busId, "busId");
      if (typeof params.muted !== "boolean") {
        throw new TypeError("audio.setBusMuted requires boolean muted");
      }
      runtime.setAudioBusMuted(busId, params.muted);
      return runtime.query();
    }

    case "navigation.bake": {
      const positions = Array.isArray(params.positions)
        ? (params.positions as number[])
        : undefined;
      const indices = Array.isArray(params.indices)
        ? (params.indices as number[])
        : undefined;
      const config = isRecord(params.config) ? params.config : undefined;
      await runtime.bakeNavigation({
        ...(positions !== undefined ? { positions } : {}),
        ...(indices !== undefined ? { indices } : {}),
        ...(config !== undefined ? { config } : {}),
      });
      return runtime.query();
    }

    case "navigation.load": {
      const dataBase64 = requireString(params.dataBase64, "dataBase64");
      await runtime.loadNavigation(dataBase64);
      return runtime.query();
    }

    case "navigation.closestPoint": {
      if (!Array.isArray(params.position) || params.position.length !== 3) {
        throw new TypeError(
          "navigation.closestPoint requires [x, y, z] position",
        );
      }
      const position = params.position as [number, number, number];
      const halfExtents =
        Array.isArray(params.halfExtents) && params.halfExtents.length === 3
          ? (params.halfExtents as [number, number, number])
          : undefined;
      runtime.closestPoint(position, halfExtents);
      return runtime.query();
    }

    case "navigation.computePath": {
      if (!Array.isArray(params.start) || params.start.length !== 3) {
        throw new TypeError("navigation.computePath requires [x, y, z] start");
      }
      if (!Array.isArray(params.end) || params.end.length !== 3) {
        throw new TypeError("navigation.computePath requires [x, y, z] end");
      }
      const start = params.start as [number, number, number];
      const end = params.end as [number, number, number];
      const halfExtents =
        Array.isArray(params.halfExtents) && params.halfExtents.length === 3
          ? (params.halfExtents as [number, number, number])
          : undefined;
      runtime.computePath(start, end, halfExtents);
      return runtime.query();
    }

    case "save.capture": {
      const slotId = typeof params.slotId === "string" ? params.slotId : "default";
      const result = await runtime.captureSave(slotId);
      return result;
    }

    case "save.get": {
      const slotId = typeof params.slotId === "string" ? params.slotId : "default";
      const envelope = await runtime.getSave(slotId);
      return { success: !!envelope, envelope };
    }

    case "save.load": {
      const slotId = typeof params.slotId === "string" ? params.slotId : undefined;
      const envelope = isRecord(params.envelope)
        ? (params.envelope as Record<string, unknown> as any)
        : undefined;
      const result = await runtime.loadSave({
        ...(slotId !== undefined ? { slotId } : {}),
        ...(envelope !== undefined ? { envelope } : {}),
      });
      return { ...result, ...runtime.query() };
    }

    case "testHarness.enableTestFixtures": {
      const preset = requireString(params.preset, "preset");
      if (preset === "save-load-atomicity") {
        runtime.enableTestScriptFixtures("save-load-atomicity");
        return { enabled: true, preset };
      }
      throw new Error(`Unsupported test fixture preset: "${preset}"`);
    }

    case "runtime.stop":
      await runtime.stop();
      shell.setMode("mainMenu");
      await shell.refreshContinueAvailable();
      statusElement.textContent = "agent runtime · stopped";
      return { stopped: true };

    case "runtime.query": {
      const entityIds =
        Array.isArray(params.entityIds) &&
        params.entityIds.every((value) => typeof value === "string")
          ? (params.entityIds as string[])
          : undefined;

      return {
        ...runtime.query({
          ...(entityIds !== undefined ? { entityIds } : {}),
        }),
        settings: shell.getSettings(),
      };
    }

    case "runtime.injectInput": {
      const action = requireString(params.action, "action");
      const phase =
        params.phase === "press" ||
        params.phase === "release" ||
        params.phase === "hold"
          ? params.phase
          : "press";

      const value =
        typeof params.value === "number" ||
        (Array.isArray(params.value) &&
          params.value.length === 2 &&
          params.value.every((item) => typeof item === "number"))
          ? (params.value as number | [number, number])
          : undefined;

      const durationMs =
        typeof params.durationMs === "number" && params.durationMs >= 0
          ? params.durationMs
          : undefined;

      runtime.injectInput({
        action,
        phase,
        ...(value !== undefined ? { value } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
      });

      return { accepted: true };
    }

    case "runtime.readLogs": {
      const sinceSequence =
        Number.isInteger(params.sinceSequence) &&
        (params.sinceSequence as number) >= 0
          ? (params.sinceSequence as number)
          : 0;

      return runtime.readLogs(sinceSequence);
    }

    case "runtime.render":
      runtime.renderOnce();
      return runtime.query();

    case "runtime.captureFrame": {
      if (!runtime.query().running) {
        return { available: false };
      }
      const base64 = runtime.captureFrameBase64();
      return {
        available: true,
        mimeType: "image/png",
        base64,
      };
    }

    default:
      throw new Error(
        `Unsupported renderer runtime command "${request.method}"`,
      );
  }
}

await shell.init();
window.kinetraRuntimeBridge?.onCommand(handleRuntimeCommand);

const demoProject: ProjectDocument = {
  schemaVersion: 1,
  projectId: "project_player_demo",
  name: "Kinetra Player",
  scenes: [
    {
      id: "scene_player_demo",
      name: "Player demo",
      entities: [
        {
          id: "entity_demo_box",
          name: "Demo Box",
          components: {
            Primitive: {
              kind: "box",
              size: [1, 1, 1],
              color: "#d9e6ff",
            },
            Transform: {
              position: [0, 0.5, 0],
            },
          },
        },
        {
          id: "entity_demo_floor",
          name: "Floor",
          components: {
            Primitive: {
              kind: "box",
              size: [12, 0.1, 12],
              color: "#1b2230",
              roughness: 0.9,
            },
            Transform: {
              position: [0, -0.05, 0],
            },
          },
        },
        {
          id: "entity_demo_camera",
          name: "Camera",
          components: {
            Camera: {
              type: "perspective",
              fov: 60,
              near: 0.1,
              far: 100,
            },
            Transform: {
              position: [0, 2, 6],
            },
          },
        },
        {
          id: "entity_demo_key",
          name: "Key Light",
          components: {
            Light: {
              kind: "directional",
              color: "#ffffff",
              intensity: 3,
            },
            Transform: {
              position: [4, 6, 3],
            },
          },
        },
        {
          id: "entity_demo_ambient",
          name: "Ambient",
          components: {
            Light: {
              kind: "ambient",
              color: "#6f89b8",
              intensity: 0.8,
            },
          },
        },
      ],
    },
  ],
};

let lastTime = performance.now();
function frame(now: number): void {
  const deltaSeconds = Math.min(Math.max((now - lastTime) / 1000, 0), 0.1);
  lastTime = now;
  runtime.frame(deltaSeconds);
  shell.updateFromRuntime();
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);

async function updatePlatformStatus(): Promise<void> {
  if (!window.kinetraPlatform) {
    statusElement.textContent = "browser runtime";
    return;
  }

  const [state, saveRoot] = await Promise.all([
    window.kinetraPlatform.getWindowState(),
    window.kinetraPlatform.getUserDataPath(),
  ]);

  statusElement.textContent =
    `desktop · ${state.fullscreen ? "fullscreen" : "windowed"} · save root: ${saveRoot}`;
}

fullscreenButton.addEventListener("click", async () => {
  if (!window.kinetraPlatform) {
    await document.documentElement.requestFullscreen();
    return;
  }

  const state = await window.kinetraPlatform.getWindowState();
  await window.kinetraPlatform.setFullscreen(!state.fullscreen);
  await updatePlatformStatus();
});

void updatePlatformStatus();
