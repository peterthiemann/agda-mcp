import assert from "node:assert/strict";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { parseServerOptions } from "../../src/application/config.js";
import { ApplicationError } from "../../src/application/errors.js";
import {
  discoverAgdaInstallation,
  resolveAgdaExecutable,
  type ProbeRunner,
} from "../../src/discovery/agdaInstallation.js";

async function executableFixture(): Promise<{ directory: string; executable: string }> {
  const directory = await mkdtemp(path.join(tmpdir(), "agda-mcp-installation-"));
  const executable = path.join(directory, "agda-test");
  await writeFile(executable, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(executable, 0o755);
  return { directory, executable };
}

test("executable resolution searches the supplied PATH and returns a real path", async () => {
  const fixture = await executableFixture();
  try {
    assert.equal(
      await resolveAgdaExecutable("agda-test", { environment: { PATH: fixture.directory } }),
      await realpath(fixture.executable),
    );
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("Agda probes select the pinned adapter and report unverified versions", async () => {
  const fixture = await executableFixture();
  const calls: string[] = [];
  const runner: ProbeRunner = async (_executable, arguments_, probeOptions) => {
    assert.equal(probeOptions.timeoutMs, 1234);
    const argument = arguments_[0];
    if (argument === undefined) throw new Error("Expected one probe argument");
    calls.push(argument);
    const values: Record<string, string> = {
      "--numeric-version": "2.9.0\n",
      "--print-agda-app-dir": "/app\n",
      "--print-agda-data-dir": "/data\n",
    };
    return { stdout: values[argument] ?? "", stderr: "" };
  };

  try {
    const installation = await discoverAgdaInstallation(
      parseServerOptions({ agdaExecutable: fixture.executable, commandTimeoutMs: 1234 }),
      { runner },
    );
    assert.equal(installation.version, "2.9.0");
    assert.equal(installation.adapter, "agda-2.8.0");
    assert.equal(installation.compatibility, "unverified");
    assert.match(installation.warnings[0] ?? "", /unverified/);
    assert.deepEqual(calls.sort(), [
      "--numeric-version",
      "--print-agda-app-dir",
      "--print-agda-data-dir",
    ]);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("missing configured executables return AGDA_NOT_FOUND", async () => {
  await assert.rejects(
    resolveAgdaExecutable("/definitely/missing/agda"),
    (error: unknown) => error instanceof ApplicationError && error.code === "AGDA_NOT_FOUND",
  );
});
