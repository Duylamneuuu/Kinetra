import MonacoEditor from "@monaco-editor/react";
import {
  serializeProject,
  type EntityDefinition,
  type JsonObject,
  type JsonValue,
  type ProjectDocument,
} from "@kinetra/project-model";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { COMPONENT_SCHEMAS } from "./component-schema.js";
import { EditorSession } from "./session.js";
import {
  ViewportController,
  type ViewportStats,
} from "./viewport.js";

interface AppProps {
  project: ProjectDocument;
  projectPath: string | null;
  writable: boolean;
}

function asObject(value: JsonValue | undefined): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : undefined;
}

function vec3(
  value: JsonValue | undefined,
  fallback: [number, number, number],
): [number, number, number] {
  return (
    Array.isArray(value) &&
    value.length >= 3 &&
    value.slice(0, 3).every((item) => typeof item === "number")
      ? [value[0] as number, value[1] as number, value[2] as number]
      : fallback
  );
}

export function App({
  project,
  projectPath,
  writable,
}: AppProps) {
  const sessionRef = useRef<EditorSession | null>(null);

  if (!sessionRef.current) {
    sessionRef.current = new EditorSession(project, {
      ...(writable && window.kinetraEditor
        ? {
            persist: async (nextProject) => {
              await window.kinetraEditor?.saveProjectText(
                serializeProject(nextProject),
              );
            },
          }
        : {}),
    });
  }

  const session = sessionRef.current;
  const [snapshot, setSnapshot] = useState(session.snapshot());
  const [sceneId, setSceneId] = useState(
    snapshot.project.scenes[0]?.id ?? "",
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [stats, setStats] = useState<ViewportStats>({
    calls: 0,
    triangles: 0,
    objects: 0,
  });
  const [transformMode, setTransformMode] = useState<
    "translate" | "rotate" | "scale"
  >("translate");
  const [componentName, setComponentName] = useState("Transform");
  const [jsonText, setJsonText] = useState("{}");
  const [error, setError] = useState<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewportRef = useRef<ViewportController | null>(null);

  const scene = snapshot.project.scenes.find(
    (candidate) => candidate.id === sceneId,
  );

  const selected = useMemo(() => {
    if (!selectedId) {
      return undefined;
    }

    for (const candidateScene of snapshot.project.scenes) {
      const entity = candidateScene.entities.find(
        (candidate) => candidate.id === selectedId,
      );
      if (entity) {
        return entity;
      }
    }

    return undefined;
  }, [snapshot, selectedId]);

  const assets = useMemo(() => {
    const ids = new Set<string>();

    for (const candidateScene of snapshot.project.scenes) {
      for (const entity of candidateScene.entities) {
        const model = asObject(entity.components.Model);
        const assetId = model?.assetId;
        if (typeof assetId === "string") {
          ids.add(assetId);
        }
      }
    }

    return [...ids].sort();
  }, [snapshot]);

  const refresh = (): void => {
    const next = session.snapshot();
    setSnapshot(next);
  };

  const runMutation = async (
    operation: () => Promise<unknown>,
  ): Promise<void> => {
    try {
      setError(null);
      await operation();
      refresh();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : String(caught),
      );
    }
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const viewport = new ViewportController(canvas, {
      onSelect: setSelectedId,
      onTransformCommit: async (entityId, transform) => {
        if (playing) {
          return;
        }

        await runMutation(() =>
          session.patchTransform(entityId, transform),
        );
      },
      onStats: setStats,
    });

    viewportRef.current = viewport;

    return () => {
      viewport.dispose();
      viewportRef.current = null;
    };
  }, []);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !sceneId) {
      return;
    }

    viewport.load(snapshot.project, sceneId);
    viewport.setTransformMode(transformMode);
  }, [snapshot, sceneId, transformMode]);

  useEffect(() => {
    viewportRef.current?.setTransformMode(transformMode);
  }, [transformMode]);

  useEffect(() => {
    if (!selected) {
      setJsonText("{}");
      return;
    }

    const components = Object.keys(selected.components);
    const nextComponent =
      components.includes(componentName)
        ? componentName
        : components[0] ?? "Transform";

    setComponentName(nextComponent);
    setJsonText(
      JSON.stringify(
        selected.components[nextComponent] ?? {},
        null,
        2,
      ),
    );
  }, [selected?.id, snapshot.revision]);

  const selectedComponent = selected
    ? asObject(selected.components[componentName])
    : undefined;

  const schema = COMPONENT_SCHEMAS[componentName];

  const patchSchemaField = async (
    key: string,
    value: JsonValue,
  ): Promise<void> => {
    if (!selected || playing) {
      return;
    }

    await runMutation(() =>
      session.patchComponent(selected.id, componentName, {
        [key]: value,
      }),
    );
  };

  const applyMonaco = async (): Promise<void> => {
    if (!selected || playing) {
      return;
    }

    try {
      const parsed = JSON.parse(jsonText) as unknown;
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        throw new TypeError("Component JSON must be an object");
      }

      await runMutation(() =>
        session.patchComponent(
          selected.id,
          componentName,
          parsed as JsonObject,
        ),
      );
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : String(caught),
      );
    }
  };

  const renderEntity = (entity: EntityDefinition, depth = 0) => {
    const children =
      scene?.entities.filter(
        (candidate) => candidate.parentId === entity.id,
      ) ?? [];

    return (
      <div key={entity.id}>
        <button
          className={
            entity.id === selectedId
              ? "tree-item selected"
              : "tree-item"
          }
          style={{ paddingLeft: 10 + depth * 14 }}
          onClick={() => viewportRef.current?.select(entity.id)}
        >
          {entity.name}
        </button>
        {children.map((child) => renderEntity(child, depth + 1))}
      </div>
    );
  };

  const rootEntities =
    scene?.entities.filter((entity) => !entity.parentId) ?? [];

  return (
    <main className="editor-shell">
      <header className="toolbar">
        <strong>Kinetra</strong>
        <span className="muted">
          {projectPath ?? "in-memory demo"} · rev {snapshot.revision}
        </span>

        <select
          value={sceneId}
          onChange={(event) => {
            setSceneId(event.target.value);
            setSelectedId(null);
          }}
        >
          {snapshot.project.scenes.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.name}
            </option>
          ))}
        </select>

        <button
          onClick={() => setPlaying((value) => !value)}
          className={playing ? "danger" : "primary"}
        >
          {playing ? "■ Stop" : "▶ Play"}
        </button>

        <button
          disabled={playing || !sceneId}
          onClick={() =>
            void runMutation(() => session.createBox(sceneId))
          }
        >
          + Box
        </button>

        <div className="segmented">
          {(["translate", "rotate", "scale"] as const).map((mode) => (
            <button
              key={mode}
              className={mode === transformMode ? "active" : ""}
              onClick={() => setTransformMode(mode)}
            >
              {mode}
            </button>
          ))}
        </div>

        <span className="stats">
          {stats.calls} calls · {stats.triangles} tris · {stats.objects} objects
        </span>
      </header>

      <section className="workspace">
        <aside className="panel hierarchy">
          <h2>Hierarchy</h2>
          {rootEntities.map((entity) => renderEntity(entity))}
        </aside>

        <section className="viewport-panel">
          <canvas ref={canvasRef} className="viewport" />
          {playing && (
            <div className="play-badge">
              PLAY MODE · authoring mutations disabled
            </div>
          )}
        </section>

        <aside className="panel inspector">
          <h2>Inspector</h2>

          {!selected && <p className="muted">Select an entity.</p>}

          {selected && (
            <>
              <div className="entity-title">
                <strong>{selected.name}</strong>
                <code>{selected.id}</code>
              </div>

              <select
                value={componentName}
                onChange={(event) => {
                  const name = event.target.value;
                  setComponentName(name);
                  setJsonText(
                    JSON.stringify(
                      selected.components[name] ?? {},
                      null,
                      2,
                    ),
                  );
                }}
              >
                {Object.keys(selected.components).map((name) => (
                  <option key={name}>{name}</option>
                ))}
              </select>

              {schema && selectedComponent && (
                <div className="schema-fields">
                  {schema.fields.map((field) => {
                    const value = selectedComponent[field.key];

                    if (field.kind === "vec3") {
                      const current = vec3(
                        value,
                        field.key === "scale"
                          ? [1, 1, 1]
                          : [0, 0, 0],
                      );

                      return (
                        <label key={field.key}>
                          <span>{field.label}</span>
                          <div className="vec3">
                            {current.map((number, index) => (
                              <input
                                key={index}
                                type="number"
                                step="0.1"
                                value={number}
                                disabled={playing}
                                onChange={(event) => {
                                  const next = [...current] as [
                                    number,
                                    number,
                                    number,
                                  ];
                                  next[index] =
                                    Number(event.target.value) || 0;
                                  void patchSchemaField(
                                    field.key,
                                    next,
                                  );
                                }}
                              />
                            ))}
                          </div>
                        </label>
                      );
                    }

                    return (
                      <label key={field.key}>
                        <span>{field.label}</span>
                        <input
                          value={
                            typeof value === "string" ||
                            typeof value === "number"
                              ? String(value)
                              : ""
                          }
                          disabled={playing}
                          onChange={(event) => {
                            const nextValue =
                              field.kind === "number"
                                ? Number(event.target.value)
                                : event.target.value;
                            void patchSchemaField(
                              field.key,
                              nextValue,
                            );
                          }}
                        />
                      </label>
                    );
                  })}
                </div>
              )}

              <button
                disabled={playing}
                className="danger-outline"
                onClick={() =>
                  void runMutation(() =>
                    session.deleteEntity(selected.id, true),
                  ).then(() => {
                    setSelectedId(null);
                  })
                }
              >
                Delete entity
              </button>
            </>
          )}
        </aside>

        <aside className="panel assets">
          <h2>Assets</h2>
          {assets.length === 0 ? (
            <p className="muted">
              No Model asset IDs yet. P4 will provide the real asset database.
            </p>
          ) : (
            assets.map((asset) => <code key={asset}>{asset}</code>)
          )}
        </aside>

        <section className="panel code-panel">
          <div className="panel-heading">
            <h2>Component JSON · Monaco</h2>
            <button
              disabled={!selected || playing}
              onClick={() => void applyMonaco()}
            >
              Apply via CommandBus
            </button>
          </div>
          <MonacoEditor
            height="100%"
            language="json"
            theme="vs-dark"
            value={jsonText}
            onChange={(value) => setJsonText(value ?? "{}")}
            options={{
              minimap: { enabled: false },
              fontSize: 12,
              automaticLayout: true,
            }}
          />
        </section>

        <section className="panel console">
          <div className="panel-heading">
            <h2>Command history / console</h2>
            <span className="muted">
              every editor mutation is the AI command path
            </span>
          </div>
          {error && <pre className="error">{error}</pre>}
          <div className="log-list">
            {session
              .events()
              .slice()
              .reverse()
              .slice(0, 100)
              .map((event) => (
                <div key={event.id} className="log-row">
                  <code>r{event.revision}</code>
                  <span>{event.operation}</span>
                  <span>
                    {event.commands
                      .map((command) => command.command)
                      .join(", ") || "undo"}
                  </span>
                  <span>{event.changes.length} changes</span>
                </div>
              ))}
          </div>
        </section>
      </section>
    </main>
  );
}
