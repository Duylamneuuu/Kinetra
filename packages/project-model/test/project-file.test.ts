import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createProject, serializeProject, stableId } from "../src/index.js";
import { reportProjectText } from "../src/project-file.js";

const cliPath = join(dirname(fileURLToPath(import.meta.url)), "../src/cli.js");

test("project file report summarizes a valid file and rejects invalid JSON", async () => {
  const project = createProject({
    name: "File report",
    projectId: stableId("project", "file-report"),
  });
  const text = serializeProject(project);
  const directory = await mkdtemp(join(tmpdir(), "kinetra-project-file-"));

  try {
    const projectPath = join(directory, "game.kinetra.json");
    await writeFile(projectPath, text);

    const report = reportProjectText(text);
    assert.equal(report.ok, true);
    if (report.ok) {
      assert.equal(report.name, "File report");
      assert.equal(report.schemaVersion, 1);
      assert.deepEqual(report.scenes, []);
    }

    const ran = spawnSync(process.execPath, [cliPath, projectPath], { encoding: "utf8" });
    assert.equal(ran.status, 0, ran.stderr);
    const cliReport = JSON.parse(ran.stdout) as { ok: boolean; name: string };
    assert.equal(cliReport.ok, true);
    assert.equal(cliReport.name, "File report");
    assert.equal(await readFile(projectPath, "utf8"), text);

    const invalid = reportProjectText("{");
    assert.equal(invalid.ok, false);

    const unnamed = reportProjectText(
      JSON.stringify({ schemaVersion: 1, projectId: "project_x", name: "", scenes: [] }),
    );
    assert.equal(unnamed.ok, false);
    if (!unnamed.ok) {
      assert.equal(unnamed.issues?.some((issue) => issue.code === "project.name.empty"), true);
    }

    const missing = spawnSync(process.execPath, [cliPath, join(directory, "missing.kinetra.json")], {
      encoding: "utf8",
    });
    assert.equal(missing.status, 1);
    const missingReport = JSON.parse(missing.stdout) as { ok: boolean; message: string };
    assert.equal(missingReport.ok, false);
    assert.match(missingReport.message, /Cannot read project file/);

    const usage = spawnSync(process.execPath, [cliPath], { encoding: "utf8" });
    assert.equal(usage.status, 2);
    assert.match(usage.stderr, /Usage:/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
