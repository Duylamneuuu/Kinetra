import type { ProjectDocument } from "@kinetra/project-model";

import { PlayerRuntimeController } from "./runtime-controller.js";
import "./style.css";

const canvas = document.querySelector<HTMLCanvasElement>("#game");
const status = document.querySelector<HTMLSpanElement>("#status");
const fullscreenButton =
  document.querySelector<HTMLButtonElement>("#fullscreen");

if (!canvas || !status || !fullscreenButton) {
  throw new Error("Kinetra player bootstrap DOM is incomplete");
}

const statusElement = status;
const runtime = new PlayerRuntimeController(canvas);

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
      const result = runtime.start(project, sceneId, projectRevision);
      statusElement.textContent =
        `agent runtime · scene ${sceneId} · revision ${projectRevision}`;
      return result;
    }

    case "runtime.stop":
      runtime.stop();
      statusElement.textContent = "agent runtime · stopped";
      return { stopped: true };

    case "runtime.query": {
      const entityIds =
        Array.isArray(params.entityIds) &&
        params.entityIds.every((value) => typeof value === "string")
          ? (params.entityIds as string[])
          : undefined;

      return runtime.query({
        ...(entityIds !== undefined ? { entityIds } : {}),
      });
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

    default:
      throw new Error(
        `Unsupported renderer runtime command "${request.method}"`,
      );
  }
}

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

runtime.start(demoProject, "scene_player_demo", 0);

function frame(): void {
  runtime.frame();
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
