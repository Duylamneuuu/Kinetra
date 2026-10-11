import assert from "node:assert/strict";
import test from "node:test";

import { CommandBus, type CommandEvent } from "@kinetra/command-bus";
import { KinetraAgentService } from "@kinetra/mcp-server";
import type { ProjectDocument } from "@kinetra/project-model";

import { EditorConsole, EditorSession, toConsoleJson } from "../src/index.js";

function fixture(): ProjectDocument {
  return {
    schemaVersion: 1,
    projectId: "project_console",
    name: "Console fixture",
    scenes: [
      {
        id: "scene_main",
        name: "Main",
        entities: [{ id: "hero", name: "Hero", components: { Stats: { hp: 10 } } }],
      },
    ],
  };
}

test("log keeps arrival order, assigns increasing seq and returns a copy", () => {
  const log = new EditorConsole();
  const first = log.log("info", "runtime", "boot", { fps: 60 });
  log.log("error", "runtime", "boom");
  assert.equal(first.seq, 1);
  first.message = "mutated";
  assert.deepEqual(
    log.entries().map((entry) => [entry.seq, entry.level, entry.message]),
    [
      [1, "info", "boot"],
      [2, "error", "boom"],
    ],
  );
  assert.deepEqual(log.entries()[0]?.data, { fps: 60 });
  const copy = log.entries();
  copy[0]!.message = "changed";
  assert.equal(log.entries()[0]?.message, "boot");
});

test("entries are cut to maxEntries, oldest first, and droppedCount says how many", () => {
  const log = new EditorConsole({ maxEntries: 3 });
  for (let index = 1; index <= 10; index += 1) log.log("info", "runtime", `m${index}`);
  assert.deepEqual(log.entries().map((entry) => entry.message), ["m8", "m9", "m10"]);
  assert.equal(log.droppedCount, 7);
  assert.equal(log.size, 3);
  assert.equal(log.entries()[0]?.seq, 8, "seq is not renumbered after trimming");
});

test("maxEntries must be a positive integer", () => {
  for (const bad of [0, -1, 1.5, Number.NaN, Infinity]) {
    assert.throws(() => new EditorConsole({ maxEntries: bad }), RangeError, String(bad));
  }
  assert.doesNotThrow(() => new EditorConsole({ maxEntries: 1 }));
});

test("filters by minimum level, exact levels, source, sinceSeq and limit", () => {
  const log = new EditorConsole();
  log.log("debug", "runtime", "d");
  log.log("info", "runtime", "i");
  log.log("warn", "editor", "w");
  log.log("error", "runtime", "e");
  const messages = (filter: Parameters<EditorConsole["entries"]>[0]) => log.entries(filter).map((entry) => entry.message);
  assert.deepEqual(messages({ minLevel: "warn" }), ["w", "e"]);
  assert.deepEqual(messages({ levels: ["debug", "error"] }), ["d", "e"]);
  assert.deepEqual(messages({ sources: ["runtime"] }), ["d", "i", "e"]);
  assert.deepEqual(messages({ sources: ["runtime"], minLevel: "info" }), ["i", "e"]);
  assert.deepEqual(messages({ sinceSeq: 2 }), ["w", "e"]);
  assert.deepEqual(messages({ limit: 2 }), ["w", "e"]);
  assert.deepEqual(messages({ limit: 0 }), []);
  assert.deepEqual(messages({ levels: [] }), []);
  assert.deepEqual(messages({ minLevel: "bogus" as never }), ["d", "i", "w", "e"]);
});

test("an unknown level is recorded as info and bad arguments never throw", () => {
  const log = new EditorConsole();
  log.log("loud" as never, "", "x");
  log.log("info", undefined as never, undefined as never);
  const [first, second] = log.entries();
  assert.equal(first?.level, "info");
  assert.equal(first?.source, "unknown");
  assert.equal(second?.source, "unknown");
  assert.equal(second?.message, "");
});

test("unserialisable data is reduced to markers instead of crashing the console", () => {
  const circular: Record<string, unknown> = { name: "loop" };
  circular["self"] = circular;
  const throwing = {
    get boom(): never {
      throw new Error("getter");
    },
    ok: 1,
  };
  const log = new EditorConsole();
  log.log("warn", "runtime", "payload", {
    circular,
    big: 10n,
    fn: () => 1,
    sym: Symbol("s"),
    nan: Number.NaN,
    inf: -Infinity,
    undef: undefined,
    date: new Date(Number.NaN),
    when: new Date(0),
    err: new RangeError("bad"),
    map: new Map([[1, 2]]),
    set: new Set([1]),
    throwing,
    toJson: { toJSON: () => { throw new Error("nope"); } },
  });
  const data = log.entries()[0]?.data as Record<string, unknown>;
  assert.deepEqual(data["circular"], { name: "loop", self: "[circular]" });
  assert.equal(data["big"], "10n");
  assert.equal(data["fn"], "[function]");
  assert.equal(data["sym"], "[symbol]");
  assert.equal(data["nan"], "[NaN]");
  assert.equal(data["inf"], "[-Infinity]");
  assert.equal("undef" in data, false);
  assert.equal(data["date"], "[invalid date]");
  assert.equal(data["when"], "1970-01-01T00:00:00.000Z");
  assert.deepEqual(data["err"], { name: "RangeError", message: "bad" });
  assert.equal(data["map"], "[Map(1)]");
  assert.equal(data["set"], "[Set(1)]");
  assert.deepEqual(data["throwing"], { boom: "[unserializable]", ok: 1 });
  assert.deepEqual(data["toJson"], { toJSON: "[function]" });
  assert.doesNotThrow(() => JSON.stringify(log.entries()));
});

test("toConsoleJson bounds depth, breadth and string length", () => {
  let deep: unknown = "leaf";
  for (let level = 0; level < 30; level += 1) deep = { child: deep };
  assert.match(JSON.stringify(toConsoleJson(deep)), /\[max depth\]/);
  const wide = toConsoleJson(Array.from({ length: 500 }, (_, index) => index)) as unknown[];
  assert.equal(wide.length, 101);
  assert.equal(wide[100], "[400 more]");
  const text = toConsoleJson("x".repeat(5000)) as string;
  assert.ok(text.length < 2100);
  assert.match(text, /truncated 3000 chars/);
  const keys = toConsoleJson(Object.fromEntries(Array.from({ length: 150 }, (_, index) => [`k${index}`, index]))) as Record<string, unknown>;
  assert.equal(Object.keys(keys).length, 101);
  assert.equal(toConsoleJson(undefined), undefined);
  assert.equal(toConsoleJson(null), null);
  const shared = { a: 1 };
  assert.deepEqual(toConsoleJson({ x: shared, y: shared }), { x: { a: 1 }, y: { a: 1 } }, "shared refs are not cycles");
});

test("subscribe delivers new entries, unsubscribe stops them and is idempotent", () => {
  const log = new EditorConsole();
  const seen: string[] = [];
  const stop = log.subscribe((entry) => seen.push(entry.message));
  log.log("info", "runtime", "one");
  stop();
  stop();
  log.log("info", "runtime", "two");
  assert.deepEqual(seen, ["one"]);
});

test("a throwing listener is counted and does not stop others or the log", () => {
  const log = new EditorConsole();
  const seen: string[] = [];
  log.subscribe(() => {
    throw new Error("listener bug");
  });
  log.subscribe((entry) => seen.push(entry.message));
  assert.doesNotThrow(() => log.log("info", "runtime", "x"));
  assert.deepEqual(seen, ["x"]);
  assert.equal(log.listenerErrorCount, 1);
  assert.equal(log.size, 1);
});

test("a listener removed during dispatch is not called, and a mutating listener cannot corrupt entries", () => {
  const log = new EditorConsole();
  const calls: string[] = [];
  let stopSecond: () => void = () => {};
  log.subscribe((entry) => {
    calls.push("first");
    entry.message = "tampered";
    stopSecond();
  });
  stopSecond = log.subscribe(() => calls.push("second"));
  log.log("info", "runtime", "real");
  assert.deepEqual(calls, ["first"]);
  assert.equal(log.entries()[0]?.message, "real");
});

test("clear empties the list but seq keeps counting", () => {
  const log = new EditorConsole();
  log.log("info", "runtime", "a");
  log.clear();
  assert.equal(log.size, 0);
  assert.equal(log.log("info", "runtime", "b").seq, 2);
});

test("sync without a bus is a no-op", () => {
  assert.equal(new EditorConsole().sync(), 0);
});

test("sync mirrors the bus event log and only adds new events each time", () => {
  const bus = new CommandBus(fixture());
  const editor = new EditorSession(bus);
  const log = new EditorConsole();
  log.attachBus(bus);
  assert.equal(log.sync(), 0);
  editor.patchComponent("hero", "Stats", { hp: 5 });
  editor.createEntity({ sceneId: "scene_main", id: "sword", name: "Sword" });
  assert.equal(log.sync(), 2);
  assert.equal(log.sync(), 0, "second sync adds nothing");
  editor.undo();
  assert.equal(log.sync(), 1);
  const entries = log.entries({ sources: ["command"] });
  assert.deepEqual(
    entries.map((entry) => entry.event?.operation),
    ["execute", "execute", "undo"],
  );
  assert.match(entries[0]!.message, /^execute r1: component\.patch \(\d+ changes?\)$/);
  assert.equal(entries[0]?.level, "info");
});

test("replay:false starts after the current history and a late attach replays by default", () => {
  const bus = new CommandBus(fixture());
  const editor = new EditorSession(bus);
  editor.patchComponent("hero", "Stats", { hp: 1 });
  const late = new EditorConsole();
  late.attachBus(bus);
  assert.equal(late.sync(), 1);
  const fresh = new EditorConsole();
  fresh.attachBus(bus, { replay: false });
  assert.equal(fresh.sync(), 0);
  editor.patchComponent("hero", "Stats", { hp: 2 });
  assert.equal(fresh.sync(), 1);
});

test("falling behind the bounded bus log yields one gap warning plus the retained events", () => {
  const bus = new CommandBus(fixture(), 0, { maxEventLogLength: 3 });
  const editor = new EditorSession(bus);
  const log = new EditorConsole();
  log.attachBus(bus);
  for (let hp = 1; hp <= 8; hp += 1) editor.patchComponent("hero", "Stats", { hp });
  assert.equal(bus.droppedEventCount, 5);
  assert.equal(log.sync(), 4);
  const entries = log.entries();
  assert.equal(entries[0]?.level, "warn");
  assert.match(entries[0]!.message, /^5 command events left the bus event log/);
  assert.deepEqual(entries.slice(1).map((entry) => entry.event?.revision), [6, 7, 8]);
  editor.patchComponent("hero", "Stats", { hp: 99 });
  assert.equal(log.sync(), 1, "no second warning once caught up");
});

test("detachBus stops mirroring; command and log entries interleave by arrival", () => {
  const bus = new CommandBus(fixture());
  const editor = new EditorSession(bus);
  const log = new EditorConsole();
  log.attachBus(bus);
  editor.patchComponent("hero", "Stats", { hp: 3 });
  log.sync();
  log.log("warn", "runtime", "physics slow");
  editor.patchComponent("hero", "Stats", { hp: 4 });
  log.detachBus();
  assert.equal(log.sync(), 0);
  assert.deepEqual(log.entries().map((entry) => entry.source), ["command", "runtime"]);
});

test("listeners also see command entries as sync adds them", () => {
  const bus = new CommandBus(fixture());
  const editor = new EditorSession(bus);
  const log = new EditorConsole();
  log.attachBus(bus);
  const seen: number[] = [];
  log.subscribe((entry) => seen.push(entry.event?.revision ?? -1));
  editor.patchComponent("hero", "Stats", { hp: 2 });
  editor.patchComponent("hero", "Stats", { hp: 3 });
  log.sync();
  assert.deepEqual(seen, [1, 2]);
});

test("console command entries match the event log an MCP client reads for the same commands", async () => {
  const editorBus = new CommandBus(fixture());
  const editor = new EditorSession(editorBus);
  const log = new EditorConsole();
  log.attachBus(editorBus);
  const agent = new KinetraAgentService(fixture());

  editor.createScene({ id: "scene_two", name: "Two" });
  await agent.createScene({ id: "scene_two", name: "Two" });
  editor.createEntity({ sceneId: "scene_main", id: "sword", name: "Sword", parentId: "hero" });
  await agent.createEntity({ sceneId: "scene_main", id: "sword", name: "Sword", parentId: "hero" });
  editor.patchComponent("hero", "Stats", { hp: 7 });
  await agent.patchComponent({ entityId: "hero", component: "Stats", patch: { hp: 7 } });
  editor.deleteEntity("sword");
  await agent.deleteEntity({ entityId: "sword" });
  editor.undo();
  // the agent service has no undo; compare the first four events and the undo separately
  log.sync();

  const normalise = (events: CommandEvent[]) =>
    events.map((event) => ({
      operation: event.operation,
      revision: event.revision,
      changes: event.changes,
      commands: event.commands.map(({ requestId: _requestId, ...rest }) => rest),
    }));
  const mirrored = log
    .entries({ sources: ["command"] })
    .map((entry) => entry.event!)
    .filter((event) => event.operation === "execute");
  assert.deepEqual(normalise(mirrored), normalise(agent.diffSince(0).events));
  assert.equal(log.entries().at(-1)?.event?.operation, "undo");
  assert.deepEqual(
    log.entries({ sources: ["command"] }).map((entry) => entry.event),
    editorBus.eventLog(),
    "the console copies the bus log exactly",
  );
});
