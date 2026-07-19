import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { parseServerOptions } from "../../src/application/config.js";
import { ApplicationError } from "../../src/application/errors.js";
import type { AgdaInstallation } from "../../src/discovery/agdaInstallation.js";
import { agda280Adapter } from "../../src/protocol/adapters/agda-2.8.0.js";
import { AgdaProcessHost } from "../../src/protocol/processHost.js";
import { WorkspaceSessionManager } from "../../src/sessions/sessionManager.js";

const FAKE_AGDA = path.resolve("test/fixtures/process-host/fake-agda.mjs");
const INSTALLATION: AgdaInstallation = Object.freeze({
  executable: process.execPath,
  version: "2.8.0",
  applicationDirectory: "/app",
  dataDirectory: "/data",
  adapter: "agda-2.8.0",
  compatibility: "supported",
  warnings: Object.freeze([]),
});

test("reloads keep workspace identity while rotating revisions and goal handles", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "agda-mcp-session-"));
  const modulePath = path.join(directory, "Tiny.agda");
  const source = await readFile("test/fixtures/agda-2.8.0/Tiny.agda");
  await writeFile(modulePath, source);
  const manager = new WorkspaceSessionManager({
    serverOptions: parseServerOptions({ workspaceRoots: [directory], commandTimeoutMs: 2_000 }),
    installation: INSTALLATION,
    adapter: agda280Adapter,
    processHostFactory: (options) =>
      new AgdaProcessHost({
        ...options,
        executable: process.execPath,
        launchArguments: [FAKE_AGDA],
      }),
  });
  try {
    const loaded = await manager.loadModule(modulePath);
    const oldGoal = loaded.data.goals[0]?.handle;
    assert.notEqual(oldGoal, undefined);
    const checked = await manager.typecheck(loaded.data.workspace);
    assert.equal(checked.data.workspace, loaded.data.workspace);
    assert.equal(checked.data.revision, loaded.data.revision + 1);
    // A reload starts a new load generation, so prior handles are revoked.
    assert.notEqual(checked.data.goals[0]?.handle, oldGoal);
    assert.throws(
      () => manager.require(loaded.data.workspace).resolveGoal(oldGoal as string),
      (error: unknown) =>
        error instanceof ApplicationError && error.code === "STALE_GOAL_HANDLE",
    );

    await writeFile(modulePath, Buffer.concat([source, Buffer.from("\n-- changed\n")]));
    await assert.rejects(
      manager.require(loaded.data.workspace).assertSourceUnchanged(),
      (error: unknown) => error instanceof ApplicationError && error.code === "SOURCE_CHANGED",
    );
  } finally {
    await manager.terminate();
    await rm(directory, { recursive: true, force: true });
  }
});
