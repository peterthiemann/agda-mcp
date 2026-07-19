import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";

import { ApplicationError } from "../../src/application/errors.js";
import { agda280Adapter } from "../../src/protocol/adapters/agda-2.8.0.js";
import { AgdaProcessHost, type ProcessOutputPolicy } from "../../src/protocol/processHost.js";

const CONTEXT = { currentFile: "/workspace/Tiny.agda" } as const;
const FAKE_AGDA = path.resolve("test/fixtures/process-host/fake-agda.mjs");
const IGNORE_ABORT = path.resolve("test/fixtures/process-host/fake-agda-ignore-abort.mjs");

function createHost(overrides: Partial<ProcessOutputPolicy> = {}): AgdaProcessHost {
  return new AgdaProcessHost({
    executable: process.execPath,
    launchArguments: [FAKE_AGDA],
    cwd: process.cwd(),
    adapter: agda280Adapter,
    policy: {
      commandTimeoutMs: 1_000,
      rawResponseLimitBytes: 1_024,
      stderrReturnLimitBytes: 8,
      maxCommandOutputBytes: 4_096,
      abortGraceMs: 200,
      ...overrides,
    },
  });
}

function errorCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof ApplicationError && error.code === code;
}

test("process host starts on a prompt and returns bounded native transcripts", async () => {
  const host = createHost();
  try {
    await host.start();
    assert.equal(host.state, "ready");
    assert.notEqual(host.pid, undefined);
    const result = await host.sendCommand({ kind: "constraints" }, CONTEXT);

    assert.deepEqual(result.raw.events, [
      { kind: "Status", status: { checked: true } },
      { kind: "FutureEvent", retained: true },
    ]);
    assert.equal(result.raw.adapter, "agda-2.8.0");
    assert.deepEqual(result.stdoutFragments, ["non-json notice\n"]);
    assert.deepEqual(result.raw.stderr.chunks, ["stderr-d"]);
    assert.equal(result.raw.stderr.complete, false);
  } finally {
    await host.terminate();
  }
});

test("process host guarantees one active command", async () => {
  const host = createHost();
  try {
    await host.start();
    const first = host.sendCommand({ kind: "metas" }, CONTEXT);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await assert.rejects(host.sendCommand({ kind: "constraints" }, CONTEXT), errorCode("AGDA_COMMAND_REJECTED"));
    assert.equal((await first).raw.events[0] !== undefined, true);
  } finally {
    await host.terminate();
  }
});

test("timeout sends abort, rejects with COMMAND_TIMEOUT, and resynchronizes", async () => {
  const host = createHost();
  try {
    await host.start();
    await assert.rejects(
      host.sendCommand({ kind: "metas" }, CONTEXT, { timeoutMs: 10 }),
      errorCode("COMMAND_TIMEOUT"),
    );
    assert.equal(host.state, "ready");
    const next = await host.sendCommand({ kind: "constraints" }, CONTEXT);
    assert.equal(next.raw.events.length, 2);
  } finally {
    await host.terminate();
  }
});

test("explicit abort rejects the active command and waits for a prompt", async () => {
  const host = createHost();
  try {
    await host.start();
    const outcome = host.sendCommand({ kind: "metas" }, CONTEXT).then(
      () => undefined,
      (error: unknown) => error,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    await host.abort(CONTEXT);
    assert.equal(errorCode("AGDA_COMMAND_REJECTED")(await outcome), true);
    assert.equal(host.state, "ready");
  } finally {
    await host.terminate();
  }
});

test("invalid JSON and unexpected exits become typed protocol failures", async () => {
  const invalidHost = createHost();
  await invalidHost.start();
  await assert.rejects(
    invalidHost.sendCommand({ kind: "inferTopLevel", expression: "invalid" }, CONTEXT),
    errorCode("UNSUPPORTED_AGDA_PROTOCOL"),
  );
  await invalidHost.terminate();

  const exitHost = createHost();
  const exitNotification = new Promise<number | null>((resolve) => {
    exitHost.onExit((info) => resolve(info.code));
  });
  await exitHost.start();
  await assert.rejects(
    exitHost.sendCommand({ kind: "goalTypeContext", interactionPoint: 0 }, CONTEXT),
    errorCode("PROCESS_EXITED"),
  );
  assert.equal(exitHost.state, "stopped");
  assert.equal(await exitNotification, 7);
});

test("Agda's non-JSON parse diagnostic becomes AGDA_COMMAND_REJECTED", async () => {
  const host = createHost();
  try {
    await host.start();
    await assert.rejects(
      host.sendCommand(
        { kind: "inferTopLevel", expression: "malformed-command" },
        CONTEXT,
      ),
      errorCode("AGDA_COMMAND_REJECTED"),
    );
    assert.equal(host.state, "ready");
  } finally {
    await host.terminate();
  }
});

test("the aggregate hard output limit stops a flooding child", async () => {
  const host = createHost({ maxCommandOutputBytes: 256 });
  await host.start();
  await assert.rejects(
    host.sendCommand({ kind: "computeTopLevel", expression: "flood" }, CONTEXT),
    errorCode("OUTPUT_LIMIT_EXCEEDED"),
  );
  await host.terminate();
  assert.equal(host.state, "stopped");
});

test("the aggregate hard output limit also applies to stderr floods", async () => {
  const host = createHost({ maxCommandOutputBytes: 256 });
  await host.start();
  await assert.rejects(
    host.sendCommand({ kind: "computeTopLevel", expression: "stderr-flood" }, CONTEXT),
    errorCode("OUTPUT_LIMIT_EXCEEDED"),
  );
  await host.terminate();
  assert.equal(host.state, "stopped");
});

test("process spawning always uses an argument array with shell disabled", async () => {
  let observed:
    | { executable: string; arguments_: readonly string[]; shell: false; stdio: readonly string[] }
    | undefined;
  const host = new AgdaProcessHost(
    {
      executable: process.execPath,
      launchArguments: [FAKE_AGDA],
      cwd: process.cwd(),
      adapter: agda280Adapter,
      policy: {
        commandTimeoutMs: 1_000,
        rawResponseLimitBytes: 1_024,
        stderrReturnLimitBytes: 1_024,
        maxCommandOutputBytes: 4_096,
      },
    },
    {
      spawnProcess: (executable, arguments_, options) => {
        observed = {
          executable,
          arguments_,
          shell: options.shell,
          stdio: options.stdio,
        };
        return spawn(executable, [...arguments_], options);
      },
    },
  );
  try {
    await host.start();
    assert.equal(observed?.executable, process.execPath);
    assert.deepEqual(observed?.arguments_, [FAKE_AGDA]);
    assert.equal(observed?.shell, false);
    assert.deepEqual(observed?.stdio, ["pipe", "pipe", "pipe"]);
  } finally {
    await host.terminate();
  }
});

test("startup timeout terminates a child that never publishes a prompt", async () => {
  const host = new AgdaProcessHost({
    executable: process.execPath,
    launchArguments: ["-e", "setInterval(() => undefined, 1000)"],
    cwd: process.cwd(),
    adapter: agda280Adapter,
    policy: {
      commandTimeoutMs: 20,
      rawResponseLimitBytes: 1_024,
      stderrReturnLimitBytes: 1_024,
      maxCommandOutputBytes: 4_096,
    },
  });
  await assert.rejects(host.start(), errorCode("COMMAND_TIMEOUT"));
  await host.terminate();
  assert.equal(host.state, "stopped");
});

test("abort grace terminates an unresponsive active child", async () => {
  const host = new AgdaProcessHost({
    executable: process.execPath,
    launchArguments: [IGNORE_ABORT],
    cwd: process.cwd(),
    adapter: agda280Adapter,
    policy: {
      commandTimeoutMs: 1_000,
      rawResponseLimitBytes: 1_024,
      stderrReturnLimitBytes: 1_024,
      maxCommandOutputBytes: 4_096,
      abortGraceMs: 20,
    },
  });
  await host.start();
  const controller = new AbortController();
  const pending = host.sendCommand({ kind: "metas" }, CONTEXT, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, errorCode("AGDA_COMMAND_REJECTED"));
  await host.terminate();
  assert.equal(host.state, "stopped");
});
