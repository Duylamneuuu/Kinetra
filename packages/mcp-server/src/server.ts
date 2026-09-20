import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import {
  assertValidProject,
  type ComponentMap,
  type JsonObject,
  type ProjectDocument,
} from "@kinetra/project-model";
import {
  acceptanceManifestSchema,
  type AcceptanceManifest,
} from "@kinetra/verification";

import type { KinetraAgentService } from "./service.js";

function success(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

function failure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);

  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

async function safe<T>(operation: () => Promise<T> | T) {
  try {
    return success(await operation());
  } catch (error) {
    return failure(error);
  }
}

const jsonRecord = z.record(z.string(), z.unknown());

export function createKinetraMcpServer(service: KinetraAgentService): McpServer {
  const server = new McpServer({
    name: "kinetra",
    version: "0.0.0",
  });

  server.registerTool(
    "project.inspect",
    {
      description:
        "Inspect Kinetra project metadata, current revision, scenes and entity counts.",
      inputSchema: z.object({}),
    },
    async () => safe(() => service.inspectProject()),
  );

  server.registerTool(
    "project.diff",
    {
      description:
        "Return command events recorded after a known project revision in this server session.",
      inputSchema: z.object({
        sinceRevision: z.number().int().nonnegative().default(0),
      }),
    },
    async ({ sinceRevision }) => safe(() => service.diffSince(sinceRevision)),
  );

  server.registerTool(
    "scene.query",
    {
      description: "List scenes, optionally filtering by stable scene ID.",
      inputSchema: z.object({
        id: z.string().optional(),
      }),
    },
    async ({ id }) => safe(() => service.queryScenes(id)),
  );

  server.registerTool(
    "scene.create",
    {
      description:
        "Create a text-project scene through the transactional command bus.",
      inputSchema: z.object({
        name: z.string().min(1),
        id: z.string().min(1).optional(),
        expectedProjectRevision: z.number().int().nonnegative().optional(),
        dryRun: z.boolean().optional(),
      }),
    },
    async (input) =>
      safe(() =>
        service.createScene({
          name: input.name,
          ...(input.id !== undefined ? { id: input.id } : {}),
          ...(input.expectedProjectRevision !== undefined
            ? { expectedProjectRevision: input.expectedProjectRevision }
            : {}),
          ...(input.dryRun !== undefined ? { dryRun: input.dryRun } : {}),
        }),
      ),
  );

  server.registerTool(
    "entity.query",
    {
      description:
        "Query only relevant entities/components instead of dumping an entire scene.",
      inputSchema: z.object({
        sceneId: z.string().optional(),
        ids: z.array(z.string()).max(500).optional(),
        component: z.string().optional(),
        nameContains: z.string().optional(),
        selectComponents: z.array(z.string()).max(100).optional(),
        offset: z.number().int().nonnegative().optional(),
        limit: z.number().int().min(1).max(500).optional(),
      }),
    },
    async (query) =>
      safe(() =>
        service.queryEntities({
          ...(query.sceneId !== undefined ? { sceneId: query.sceneId } : {}),
          ...(query.ids !== undefined ? { ids: query.ids } : {}),
          ...(query.component !== undefined ? { component: query.component } : {}),
          ...(query.nameContains !== undefined
            ? { nameContains: query.nameContains }
            : {}),
          ...(query.selectComponents !== undefined
            ? { selectComponents: query.selectComponents }
            : {}),
          ...(query.offset !== undefined ? { offset: query.offset } : {}),
          ...(query.limit !== undefined ? { limit: query.limit } : {}),
        }),
      ),
  );

  server.registerTool(
    "entity.create",
    {
      description:
        "Create an entity in a scene using stable project data, not direct Three.js mutation.",
      inputSchema: z.object({
        sceneId: z.string().min(1),
        name: z.string().min(1),
        id: z.string().min(1).optional(),
        parentId: z.string().min(1).optional(),
        components: jsonRecord.optional(),
        expectedProjectRevision: z.number().int().nonnegative().optional(),
        dryRun: z.boolean().optional(),
      }),
    },
    async (input) =>
      safe(() =>
        service.createEntity({
          sceneId: input.sceneId,
          name: input.name,
          ...(input.id !== undefined ? { id: input.id } : {}),
          ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
          ...(input.components !== undefined
            ? { components: input.components as ComponentMap }
            : {}),
          ...(input.expectedProjectRevision !== undefined
            ? { expectedProjectRevision: input.expectedProjectRevision }
            : {}),
          ...(input.dryRun !== undefined ? { dryRun: input.dryRun } : {}),
        }),
      ),
  );

  server.registerTool(
    "entity.patch",
    {
      description:
        "Patch one entity component through the command bus with optional revision precondition.",
      inputSchema: z.object({
        entityId: z.string().min(1),
        component: z.string().min(1),
        patch: jsonRecord,
        expectedProjectRevision: z.number().int().nonnegative().optional(),
        dryRun: z.boolean().optional(),
      }),
    },
    async (input) =>
      safe(() =>
        service.patchComponent({
          entityId: input.entityId,
          component: input.component,
          patch: input.patch as JsonObject,
          ...(input.expectedProjectRevision !== undefined
            ? { expectedProjectRevision: input.expectedProjectRevision }
            : {}),
          ...(input.dryRun !== undefined ? { dryRun: input.dryRun } : {}),
        }),
      ),
  );

  server.registerTool(
    "entity.reparent",
    {
      description: "Reparent an entity inside its scene through a validated command.",
      inputSchema: z.object({
        entityId: z.string().min(1),
        parentId: z.string().min(1).optional(),
        expectedProjectRevision: z.number().int().nonnegative().optional(),
        dryRun: z.boolean().optional(),
      }),
    },
    async (input) =>
      safe(() =>
        service.reparentEntity({
          entityId: input.entityId,
          ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
          ...(input.expectedProjectRevision !== undefined
            ? { expectedProjectRevision: input.expectedProjectRevision }
            : {}),
          ...(input.dryRun !== undefined ? { dryRun: input.dryRun } : {}),
        }),
      ),
  );

  server.registerTool(
    "entity.delete",
    {
      description:
        "Delete an entity; cascade must be explicit when deleting a hierarchy.",
      inputSchema: z.object({
        entityId: z.string().min(1),
        cascade: z.boolean().optional(),
        expectedProjectRevision: z.number().int().nonnegative().optional(),
        dryRun: z.boolean().optional(),
      }),
    },
    async (input) =>
      safe(() =>
        service.deleteEntity({
          entityId: input.entityId,
          ...(input.cascade !== undefined ? { cascade: input.cascade } : {}),
          ...(input.expectedProjectRevision !== undefined
            ? { expectedProjectRevision: input.expectedProjectRevision }
            : {}),
          ...(input.dryRun !== undefined ? { dryRun: input.dryRun } : {}),
        }),
      ),
  );

  server.registerTool(
    "project.undo",
    {
      description: "Consume an undo token returned by a committed mutation.",
      inputSchema: z.object({
        undoToken: z.string().min(1),
        expectedProjectRevision: z.number().int().nonnegative().optional(),
      }),
    },
    async ({ undoToken, expectedProjectRevision }) =>
      safe(() => service.undo(undoToken, expectedProjectRevision)),
  );

  server.registerTool(
    "runtime.start",
    {
      description:
        "Instantiate the current project revision into the local Three.js scene-graph runtime.",
      inputSchema: z.object({
        sceneId: z.string().min(1),
      }),
    },
    async ({ sceneId }) =>
      safe(async () => {
        await service.startRuntime(sceneId);
        return service.queryRuntime();
      }),
  );

  server.registerTool(
    "runtime.stop",
    {
      description: "Stop and dispose the current local runtime projection.",
      inputSchema: z.object({}),
    },
    async () =>
      safe(async () => {
        await service.stopRuntime();
        return { stopped: true };
      }),
  );

  server.registerTool(
    "runtime.query",
    {
      description:
        "Inspect live scene-graph state for selected entities using stable entity IDs.",
      inputSchema: z.object({
        entityIds: z.array(z.string()).max(500).optional(),
      }),
    },
    async (query) =>
      safe(() =>
        service.queryRuntime({
          ...(query.entityIds !== undefined ? { entityIds: query.entityIds } : {}),
        }),
      ),
  );

  server.registerTool(
    "runtime.injectInput",
    {
      description:
        "Inject a semantic gameplay action. The local P2 host records actions; gameplay systems consume them in later phases.",
      inputSchema: z.object({
        action: z.string().min(1),
        phase: z.enum(["press", "release", "hold"]).default("press"),
        value: z.union([z.number(), z.tuple([z.number(), z.number()])]).optional(),
        durationMs: z.number().nonnegative().optional(),
      }),
    },
    async (event) =>
      safe(async () => {
        await service.injectRuntimeInput({
          action: event.action,
          phase: event.phase,
          ...(event.value !== undefined ? { value: event.value } : {}),
          ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
        });
        return { accepted: true };
      }),
  );

  server.registerTool(
    "runtime.readLogs",
    {
      description: "Read structured runtime logs after a sequence cursor.",
      inputSchema: z.object({
        sinceSequence: z.number().int().nonnegative().default(0),
      }),
    },
    async ({ sinceSequence }) =>
      safe(() => service.readRuntimeLogs(sinceSequence)),
  );

  server.registerTool(
    "runtime.captureFrame",
    {
      description:
        "Capture the connected runtime frame. Electron runtime returns a real PNG; local runtime returns explicit fallback state.",
      inputSchema: z.object({}),
    },
    async () => {
      try {
        const frame = await service.captureRuntimeFrame();

        if (frame.available && frame.base64 && frame.mimeType) {
          return {
            content: [
              {
                type: "image" as const,
                data: frame.base64,
                mimeType: frame.mimeType,
              },
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    available: true,
                    mimeType: frame.mimeType,
                    bytesApprox: Math.floor((frame.base64.length * 3) / 4),
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        return success(frame);
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "test.runAcceptance",
    {
      description:
        "Execute a Kinetra AcceptanceManifest against the real Electron runtime (target=\"runtime\") or packaged Windows executable (target=\"packaged\"), returning a complete machine-readable pass/fail report with step evidence.",
      inputSchema: z.object({
        manifest: acceptanceManifestSchema,
        target: z.enum(["runtime", "packaged"]).optional(),
        project: z.record(z.string(), z.unknown()).optional(),
        timeoutMs: z.number().int().min(1_000).max(180_000).optional(),
      }).strict(),
    },
    async (input) => {
      try {
        if (input.project !== undefined) {
          assertValidProject(input.project as unknown as ProjectDocument);
        }
        const report = await service.runAcceptance({
          manifest: input.manifest,
          ...(input.target !== undefined ? { target: input.target } : {}),
          ...(input.project !== undefined
            ? { project: input.project as unknown as ProjectDocument }
            : {}),
          ...(input.timeoutMs !== undefined
            ? { timeoutMs: input.timeoutMs }
            : {}),
        });
        return success(report);
      } catch (error) {
        return failure(error);
      }
    },
  );

  return server;
}
