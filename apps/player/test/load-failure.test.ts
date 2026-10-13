import assert from "node:assert/strict";
import { test } from "node:test";
import {
  describeLoadFailure,
  ERR_ABORTED,
  FirstExitCode,
  isAbortedLoadError,
  isFatalLoadFailure,
} from "../electron/load-failure.js";

test("a main-frame load failure is fatal", () => {
  assert.equal(isFatalLoadFailure(-6, true), true); // ERR_FILE_NOT_FOUND
  assert.equal(isFatalLoadFailure(-2, true), true); // ERR_FAILED
});

test("a sub-frame load failure is not fatal for the player", () => {
  assert.equal(isFatalLoadFailure(-6, false), false);
  assert.equal(isFatalLoadFailure(-105, false), false);
});

test("a cancelled navigation (ERR_ABORTED) is not fatal even on the main frame", () => {
  assert.equal(ERR_ABORTED, -3);
  assert.equal(isFatalLoadFailure(ERR_ABORTED, true), false);
  assert.equal(isFatalLoadFailure(ERR_ABORTED, false), false);
});

test("describeLoadFailure keeps the legacy prefix and appends the URL when known", () => {
  assert.equal(
    describeLoadFailure(-6, "ERR_FILE_NOT_FOUND"),
    "Kinetra packaged player failed to load: -6 ERR_FILE_NOT_FOUND",
  );
  assert.equal(
    describeLoadFailure(-6, "ERR_FILE_NOT_FOUND", "file:///x/index.html"),
    "Kinetra packaged player failed to load: -6 ERR_FILE_NOT_FOUND (file:///x/index.html)",
  );
  assert.equal(
    describeLoadFailure(-6, "ERR_FILE_NOT_FOUND", ""),
    "Kinetra packaged player failed to load: -6 ERR_FILE_NOT_FOUND",
  );
});

test("a missing isMainFrame argument is treated as the main frame, not swallowed", () => {
  assert.equal(isFatalLoadFailure(-6, undefined as unknown as boolean), true);
  assert.equal(isFatalLoadFailure(ERR_ABORTED, undefined as unknown as boolean), false);
});

test("isAbortedLoadError recognises the loadFile ERR_ABORTED rejection only", () => {
  assert.equal(isAbortedLoadError(Object.assign(new Error("x"), { errno: -3 })), true);
  assert.equal(isAbortedLoadError(Object.assign(new Error("x"), { code: "ERR_ABORTED" })), true);
  assert.equal(isAbortedLoadError(Object.assign(new Error("x"), { errno: -6 })), false);
  assert.equal(isAbortedLoadError(new Error("plain")), false);
  assert.equal(isAbortedLoadError("ERR_ABORTED"), false);
  assert.equal(isAbortedLoadError(null), false);
});

test("FirstExitCode: the code claimed first wins (fatal 1 beats a later pipe-close 0)", () => {
  const codes = new FirstExitCode();
  assert.equal(codes.claim(1), 1);
  assert.equal(codes.claim(0), 1);
  assert.equal(codes.claim(1), 1);
  const clean = new FirstExitCode();
  assert.equal(clean.claim(0), 0);
  assert.equal(clean.claim(1), 0);
});
