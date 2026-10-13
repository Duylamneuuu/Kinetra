import assert from "node:assert/strict";
import { test } from "node:test";
import {
  describeLoadFailure,
  ERR_ABORTED,
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
