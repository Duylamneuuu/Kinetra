import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runProcessSmoke } from "../src/index.js";

const node = process.execPath;

test("process smoke reports a non-zero exit code with stdout and stderr instead of throwing", async () => {
  const result = await runProcessSmoke({
    executable: node,
    args: ["-e", "console.log('out-line'); console.error('err-line'); process.exit(3)"],
    timeoutMs: 10_000,
  });
  assert.equal(result.exitCode, 3);
  assert.match(result.stdout, /out-line/);
  assert.match(result.stderr, /err-line/);
  assert.equal(result.stdout.includes("err-line"), false);
  assert.ok(result.durationMs >= 0 && Number.isFinite(result.durationMs));
});

test("process smoke keeps every byte of large output written right before exit", async () => {
  const bytes = 4 * 1024 * 1024;
  const result = await runProcessSmoke({
    executable: node,
    args: [
      "-e",
      `const fs=require('node:fs');const chunk='x'.repeat(65536);` +
        `for(let i=0;i<${bytes / 65536};i++)fs.writeSync(1,chunk);` +
        `fs.writeSync(1,'END');process.exit(0)`,
    ],
    timeoutMs: 20_000,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.length, bytes + 3);
  assert.ok(result.stdout.endsWith("END"));
});

test("process smoke decodes multi-byte characters split across pipe chunks", async () => {
  const count = 200_000;
  const result = await runProcessSmoke({
    executable: node,
    args: ["-e", `process.stdout.write('€'.repeat(${count}))`],
    timeoutMs: 20_000,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "€".repeat(count));
  assert.equal(result.stdout.includes("\uFFFD"), false);
});

test("process smoke rejects and kills a process that outlives the timeout", async () => {
  const started = Date.now();
  await assert.rejects(
    runProcessSmoke({
      executable: node,
      args: ["-e", "setInterval(()=>{},1000)"],
      timeoutMs: 300,
    }),
    /Process smoke timed out after 300ms/,
  );
  assert.ok(Date.now() - started < 10_000);
});

test("process smoke rejects when the executable does not exist", async () => {
  await assert.rejects(
    runProcessSmoke({
      executable: join(tmpdir(), "kinetra-definitely-missing-executable"),
      timeoutMs: 5_000,
    }),
    (error: NodeJS.ErrnoException) => error.code === "ENOENT",
  );
});

test("process smoke honours cwd and merges env over the parent environment", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kinetra-smoke-")));
  try {
    const result = await runProcessSmoke({
      executable: node,
      args: [
        "-e",
        "console.log(JSON.stringify({cwd:process.cwd(),own:process.env.KINETRA_SMOKE_OWN,path:typeof process.env.PATH}))",
      ],
      cwd: dir,
      env: { KINETRA_SMOKE_OWN: "yes" },
      timeoutMs: 10_000,
    });
    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(result.stdout) as { cwd: string; own: string; path: string };
    assert.equal(realpathSync(parsed.cwd), dir);
    assert.equal(parsed.own, "yes");
    assert.notEqual(parsed.path, "undefined");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("process smoke reports -1 when the child is killed by a signal", { skip: process.platform === "win32" }, async () => {
  const result = await runProcessSmoke({
    executable: node,
    args: ["-e", "process.kill(process.pid,'SIGKILL')"],
    timeoutMs: 10_000,
  });
  assert.equal(result.exitCode, -1);
});

test("process smoke returns promptly when a grandchild keeps the stdio pipes open", { skip: process.platform === "win32" }, async () => {
  const started = Date.now();
  const result = await runProcessSmoke({
    executable: node,
    args: [
      "-e",
      // Detached grandchild inherits stdout/stderr and lives longer than the parent.
      "require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},4000)'],{stdio:'inherit',detached:true}).unref();console.log('parent-done')",
    ],
    timeoutMs: 20_000,
  });
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /parent-done/);
  assert.ok(Date.now() - started < 3_500, "must not wait for the grandchild to close the pipes");
});
