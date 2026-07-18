import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_COMMAND_TIMEOUT_MS,
  DEFAULT_MAX_COMMAND_OUTPUT_BYTES,
  DEFAULT_RAW_RESPONSE_LIMIT_BYTES,
  DEFAULT_STDERR_RETURN_LIMIT_BYTES,
  parseServerOptions,
} from "../../src/application/config.js";
import { ApplicationError } from "../../src/application/errors.js";

function isInvalidArgument(error: unknown): boolean {
  return error instanceof ApplicationError && error.code === "INVALID_ARGUMENT";
}

test("server options apply immutable security-conscious defaults", () => {
  const options = parseServerOptions();

  assert.equal(options.agdaExecutable, "agda");
  assert.deepEqual(options.workspaceRoots, []);
  assert.deepEqual(options.includePaths, []);
  assert.deepEqual(options.libraries, []);
  assert.deepEqual(options.additionalFlags, []);
  assert.deepEqual(options.workspaceOverrides, []);
  assert.equal(options.commandTimeoutMs, DEFAULT_COMMAND_TIMEOUT_MS);
  assert.equal(options.rawResponseLimitBytes, DEFAULT_RAW_RESPONSE_LIMIT_BYTES);
  assert.equal(options.stderrReturnLimitBytes, DEFAULT_STDERR_RETURN_LIMIT_BYTES);
  assert.equal(options.maxCommandOutputBytes, DEFAULT_MAX_COMMAND_OUTPUT_BYTES);
  assert.equal(options.allowAgdaExec, false);
  assert.equal(Object.isFrozen(options), true);
  assert.equal(Object.isFrozen(options.includePaths), true);
});

test("server options parse workspace-specific overrides", () => {
  const options = parseServerOptions({
    workspaceRoots: ["/workspace"],
    includePaths: ["global"],
    allowAgdaExec: true,
    additionalFlags: ["--allow-exec"],
    workspaceOverrides: [
      {
        root: "/workspace",
        includePaths: ["local"],
        libraries: ["standard-library"],
        libraryFile: "libraries",
        additionalFlags: ["--safe"],
      },
    ],
  });

  assert.equal(options.allowAgdaExec, true);
  assert.deepEqual(options.workspaceOverrides[0], {
    root: "/workspace",
    includePaths: ["local"],
    libraries: ["standard-library"],
    libraryFile: "libraries",
    additionalFlags: ["--safe"],
  });
  assert.equal(Object.isFrozen(options.workspaceOverrides[0]), true);
});

test("server options reject malformed and inconsistent limits", () => {
  assert.throws(() => parseServerOptions(null), isInvalidArgument);
  assert.throws(() => parseServerOptions({ unexpected: true }), isInvalidArgument);
  assert.throws(() => parseServerOptions({ commandTimeoutMs: 0 }), isInvalidArgument);
  assert.throws(() => parseServerOptions({ includePaths: [""] }), isInvalidArgument);
  assert.throws(
    () => parseServerOptions({ rawResponseLimitBytes: 2, maxCommandOutputBytes: 1 }),
    isInvalidArgument,
  );
  assert.throws(
    () => parseServerOptions({ stderrReturnLimitBytes: 2, maxCommandOutputBytes: 1 }),
    isInvalidArgument,
  );
});

test("--allow-exec requires explicit initialization authorization", () => {
  assert.throws(
    () => parseServerOptions({ additionalFlags: ["--allow-exec"] }),
    isInvalidArgument,
  );
  assert.throws(
    () =>
      parseServerOptions({
        workspaceOverrides: [{ root: "/workspace", additionalFlags: ["--allow-exec=true"] }],
      }),
    isInvalidArgument,
  );
  assert.doesNotThrow(() =>
    parseServerOptions({ allowAgdaExec: true, additionalFlags: ["--allow-exec"] }),
  );
});
