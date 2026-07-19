import assert from "node:assert/strict";
import test from "node:test";

import { runCli, type CliIo } from "../../src/cli.js";

function captureIo(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      stdout: { write: (chunk) => stdout.push(chunk) },
      stderr: { write: (chunk) => stderr.push(chunk) },
    },
    stdout,
    stderr,
  };
}

test("--help describes the supported source formats", async () => {
  const output = captureIo();
  assert.equal(await runCli(["--help"], output.io), 0);
  assert.match(output.stdout.join(""), /\.agda, \.lagda, and \.lagda\.md/);
  assert.deepEqual(output.stderr, []);
});

test("--version prints the development version", async () => {
  const output = captureIo();
  assert.equal(await runCli(["--version"], output.io), 0);
  assert.equal(output.stdout.join(""), "0.0.0-development\n");
  assert.deepEqual(output.stderr, []);
});

test("the default command starts the stdio server without polluting captured output", async () => {
  const output = captureIo();
  let started = false;
  assert.equal(
    await runCli([], output.io, {
      startServer: async () => {
        started = true;
      },
    }),
    0,
  );
  assert.equal(started, true);
  assert.deepEqual(output.stdout, []);
  assert.deepEqual(output.stderr, []);
});

test("unknown arguments produce a usage error on stderr", async () => {
  const output = captureIo();
  assert.equal(await runCli(["--unknown"], output.io), 2);
  assert.deepEqual(output.stdout, []);
  assert.match(output.stderr.join(""), /unknown arguments/);
});
