import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_COMMAND_TIMEOUT_MS,
  DEFAULT_LOAD_TIMEOUT_MS,
  DEFAULT_MAX_QUEUED_COMMANDS,
  DEFAULT_MAX_COMMAND_OUTPUT_BYTES,
  DEFAULT_QUERY_TIMEOUT_MS,
  DEFAULT_RAW_RESPONSE_LIMIT_BYTES,
  DEFAULT_STDERR_RETURN_LIMIT_BYTES,
  DEFAULT_TRANSFORMATION_TIMEOUT_MS,
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
  assert.equal(options.loadTimeoutMs, DEFAULT_LOAD_TIMEOUT_MS);
  assert.equal(options.queryTimeoutMs, DEFAULT_QUERY_TIMEOUT_MS);
  assert.equal(options.transformationTimeoutMs, DEFAULT_TRANSFORMATION_TIMEOUT_MS);
  assert.equal(options.maxQueuedCommands, DEFAULT_MAX_QUEUED_COMMANDS);
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

test("legacy and operation-specific timeout options compose deterministically", () => {
  const legacy = parseServerOptions({ commandTimeoutMs: 1_234 });
  assert.equal(legacy.loadTimeoutMs, 1_234);
  assert.equal(legacy.queryTimeoutMs, 1_234);
  assert.equal(legacy.transformationTimeoutMs, 1_234);

  const specific = parseServerOptions({
    commandTimeoutMs: 1_234,
    loadTimeoutMs: 2_000,
    queryTimeoutMs: 3_000,
    transformationTimeoutMs: 4_000,
    maxQueuedCommands: 7,
  });
  assert.equal(specific.loadTimeoutMs, 2_000);
  assert.equal(specific.queryTimeoutMs, 3_000);
  assert.equal(specific.transformationTimeoutMs, 4_000);
  assert.equal(specific.maxQueuedCommands, 7);
});

test("server options reject malformed and inconsistent limits", () => {
  assert.throws(() => parseServerOptions(null), isInvalidArgument);
  assert.throws(() => parseServerOptions({ unexpected: true }), isInvalidArgument);
  assert.throws(() => parseServerOptions({ commandTimeoutMs: 0 }), isInvalidArgument);
  assert.throws(() => parseServerOptions({ loadTimeoutMs: 0 }), isInvalidArgument);
  assert.throws(() => parseServerOptions({ maxQueuedCommands: 0 }), isInvalidArgument);
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
