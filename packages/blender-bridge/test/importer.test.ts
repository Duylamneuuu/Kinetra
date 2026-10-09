import assert from "node:assert/strict";
import test from "node:test";
import { createSyntheticGlb } from "@kinetra/asset-pipeline";
import {
  BlenderGlbImporter,
  defaultExportScriptPath,
  type ProcessRunner,
} from "../src/index.js";

class MockProcessRunner implements ProcessRunner {
  lastExecutable?: string;
  lastArgs?: string[];
  exitCode = 0;
  stdout = "";
  stderr = "";
  onRun?: (executable: string, args: string[]) => Promise<void> | void;

  async run(executable: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    this.lastExecutable = executable;
    this.lastArgs = args;
    if (this.onRun) {
      await this.onRun(executable, args);
    }
    return {
      code: this.exitCode,
      stdout: this.stdout,
      stderr: this.stderr,
    };
  }
}

class MemoryFileSystem {
  readonly files = new Map<string, Uint8Array>();

  async readFile(path: string): Promise<Uint8Array> {
    const data = this.files.get(path);
    if (!data) throw new Error(`ENOENT: ${path}`);
    return data;
  }

  async writeFile(path: string, data: Uint8Array): Promise<void> {
    this.files.set(path, data);
  }
}

test("BlenderGlbImporter Unit Suite", async (t) => {
  await t.test("defaultExportScriptPath returns path pointing to export_glb.py", () => {
    const scriptPath = defaultExportScriptPath();
    assert.ok(scriptPath.endsWith("export_glb.py"), `Expected path ending with export_glb.py, got: ${scriptPath}`);
  });

  await t.test("executes runner with headless arguments and returns validated GLB artifact", async () => {
    const mockRunner = new MockProcessRunner();
    const fs = new MemoryFileSystem();
    const validGlb = await createSyntheticGlb({ size: [2, 2, 2], meshName: "TestMesh" });

    const stagingPath = "/staging/test_output.glb";
    const manifestPath = `${stagingPath}.manifest.json`;

    mockRunner.onRun = async (_exe, _args) => {
      // Runner simulates Blender writing GLB and manifest
      await fs.writeFile(stagingPath, validGlb);
      await fs.writeFile(
        manifestPath,
        new TextEncoder().encode(
          JSON.stringify({
            blenderVersion: "4.2.0",
            meshes: ["TestMesh"],
            armatures: [],
            actions: [],
          }),
        ),
      );
    };

    const importer = new BlenderGlbImporter({
      blenderExecutable: "blender-custom",
      pythonScript: "/scripts/custom_export.py",
      runner: mockRunner,
      fileSystem: fs,
    });

    const result = await importer.import({
      assetId: "asset_test",
      sourcePath: "/source/test.blend",
      sourceBytes: new Uint8Array([1, 2, 3]),
      sourceHash: "dummyhash",
      recipe: { importer: "blender-glb", importerVersion: "1.0.0", settings: {} },
      targetPath: stagingPath,
    });

    assert.equal(mockRunner.lastExecutable, "blender-custom");
    assert.deepEqual(mockRunner.lastArgs, [
      "--background",
      "/source/test.blend",
      "--python",
      "/scripts/custom_export.py",
      "--",
      "--output",
      stagingPath,
    ]);

    assert.deepEqual(result.artifactBytes, validGlb);
    assert.equal((result.metadata?.custom as any)?.blenderVersion, "4.2.0");
    assert.deepEqual((result.metadata?.custom as any)?.meshes, ["TestMesh"]);
  });

  await t.test("recipe settings can override blenderExecutable and pythonScript when the host opts in", async () => {
    const mockRunner = new MockProcessRunner();
    const fs = new MemoryFileSystem();
    const validGlb = await createSyntheticGlb({ size: [1, 1, 1] });

    mockRunner.onRun = async () => {
      await fs.writeFile("/staging/override.glb", validGlb);
    };

    const importer = new BlenderGlbImporter({
      runner: mockRunner,
      fileSystem: fs,
      allowRecipeExecutableOverrides: true,
    });

    await importer.import({
      assetId: "asset_override",
      sourcePath: "/models/model.blend",
      sourceBytes: new Uint8Array([0]),
      sourceHash: "h1",
      recipe: {
        importer: "blender-glb",
        importerVersion: "1.0.0",
        settings: {
          blenderExecutable: "/opt/blender/blender",
          pythonScript: "/opt/scripts/export.py",
        },
      },
      targetPath: "/staging/override.glb",
    });

    assert.equal(mockRunner.lastExecutable, "/opt/blender/blender");
    assert.equal(mockRunner.lastArgs?.[3], "/opt/scripts/export.py");
  });

  await t.test("throws descriptive error when Blender process exits non-zero", async () => {
    const mockRunner = new MockProcessRunner();
    mockRunner.exitCode = 1;
    mockRunner.stderr = "Python syntax error in script line 12";

    const fs = new MemoryFileSystem();
    const importer = new BlenderGlbImporter({
      runner: mockRunner,
      fileSystem: fs,
    });

    await assert.rejects(
      async () => {
        await importer.import({
          assetId: "asset_fail",
          sourcePath: "/bad.blend",
          sourceBytes: new Uint8Array([0]),
          sourceHash: "bad",
          recipe: { importer: "blender-glb", importerVersion: "1.0.0", settings: {} },
          targetPath: "/staging/bad.glb",
        });
      },
      (err: Error) => {
        assert.ok(err.message.includes("Blender export failed with code 1"));
        assert.ok(err.message.includes("Python syntax error in script"));
        return true;
      },
    );
  });

  await t.test("throws validation error when output GLB has corrupt header", async () => {
    const mockRunner = new MockProcessRunner();
    const fs = new MemoryFileSystem();

    mockRunner.onRun = async () => {
      // Write corrupted/non-GLB bytes
      await fs.writeFile("/staging/corrupt.glb", new Uint8Array([0x00, 0x01, 0x02, 0x03]));
    };

    const importer = new BlenderGlbImporter({
      runner: mockRunner,
      fileSystem: fs,
    });

    await assert.rejects(
      async () => {
        await importer.import({
          assetId: "asset_corrupt",
          sourcePath: "/corrupt.blend",
          sourceBytes: new Uint8Array([0]),
          sourceHash: "c",
          recipe: { importer: "blender-glb", importerVersion: "1.0.0", settings: {} },
          targetPath: "/staging/corrupt.glb",
        });
      },
      (err: Error) => {
        assert.ok(
          err.message.includes("magic") ||
            err.message.includes("Invalid") ||
            err.message.includes("header") ||
            err.message.includes("GLB"),
        );
        return true;
      },
    );
  });
});
