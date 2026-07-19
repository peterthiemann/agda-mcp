import assert from "node:assert/strict";
import { mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { parseServerOptions } from "../../src/application/config.js";
import { ApplicationError } from "../../src/application/errors.js";
import { AgdaApplicationService } from "../../src/application/service.js";
import type { AgdaInstallation } from "../../src/discovery/agdaInstallation.js";
import { AgdaProcessHost } from "../../src/protocol/processHost.js";

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

async function recoveryFixture(options: Record<string, unknown> = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "agda-mcp-recovery-"));
  const modulePath = path.join(directory, "Tiny.agda");
  await writeFile(modulePath, await readFile("test/fixtures/agda-2.8.0/Tiny.agda"));
  const hosts: AgdaProcessHost[] = [];
  const service = await AgdaApplicationService.create(
    parseServerOptions({ workspaceRoots: [directory], commandTimeoutMs: 2_000, ...options }),
    {
      installation: INSTALLATION,
      processHostFactory: (hostOptions) => {
        const host = new AgdaProcessHost({
          ...hostOptions,
          executable: process.execPath,
          launchArguments: [FAKE_AGDA],
        });
        hosts.push(host);
        return host;
      },
    },
  );
  return { directory, modulePath, hosts, service };
}

test("unexpected exit invalidates handles and lazily reloads an unchanged module", async () => {
  const fixture = await recoveryFixture();
  try {
    const loaded = await fixture.service.loadModule({ modulePath: fixture.modulePath });
    const goal = loaded.data.goals[0]?.handle;
    assert.notEqual(goal, undefined);
    await assert.rejects(
      fixture.service.retrieveContext({ goal: goal as string }),
      (error: unknown) => error instanceof ApplicationError && error.code === "PROCESS_EXITED",
    );
    const recovering = await fixture.service.serverInfo();
    assert.equal(recovering.data.workspaces[0]?.lifecycle, "recovering");
    await assert.rejects(
      fixture.service.refine({ goal: goal as string }),
      (error: unknown) => error instanceof ApplicationError && error.code === "STALE_GOAL_HANDLE",
    );

    const checked = await fixture.service.typecheck({ workspace: loaded.data.workspace });
    assert.equal(checked.data.revision, loaded.data.revision + 1);
    // Recovery is a fresh load generation, so prior handles do not survive it.
    assert.notEqual(checked.data.goals[0]?.handle, goal);
    assert.equal(fixture.hosts.length, 2);
    assert.equal(fixture.hosts[0]?.state, "stopped");
    assert.equal(fixture.hosts[1]?.state, "ready");
  } finally {
    await fixture.service.shutdown();
    assert.equal(fixture.hosts.every((host) => host.state === "stopped"), true);
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("recovery refuses to reload a changed source", async () => {
  const fixture = await recoveryFixture();
  try {
    const loaded = await fixture.service.loadModule({ modulePath: fixture.modulePath });
    const goal = loaded.data.goals[0]?.handle;
    await assert.rejects(fixture.service.retrieveContext({ goal: goal as string }));
    await writeFile(fixture.modulePath, `${await readFile(fixture.modulePath, "utf8")}\n-- changed\n`);
    await assert.rejects(
      fixture.service.typecheck({ workspace: loaded.data.workspace }),
      (error: unknown) => error instanceof ApplicationError && error.code === "SOURCE_CHANGED",
    );
    await assert.rejects(
      fixture.service.typecheck({ workspace: loaded.data.workspace }),
      (error: unknown) => error instanceof ApplicationError && error.code === "NO_ACTIVE_MODULE",
    );
  } finally {
    await fixture.service.shutdown();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("active operations reject a module path replaced by a symlink", async () => {
  const fixture = await recoveryFixture();
  const outside = path.join(path.dirname(fixture.directory), `${path.basename(fixture.directory)}-outside.agda`);
  try {
    await writeFile(outside, "module Outside where\n");
    const loaded = await fixture.service.loadModule({ modulePath: fixture.modulePath });
    await rename(fixture.modulePath, `${fixture.modulePath}.original`);
    await symlink(outside, fixture.modulePath);
    await assert.rejects(
      fixture.service.retrieveGoals({ workspace: loaded.data.workspace }),
      (error: unknown) => error instanceof ApplicationError && error.code === "PATH_OUTSIDE_WORKSPACE",
    );
  } finally {
    await fixture.service.shutdown();
    await rm(fixture.directory, { recursive: true, force: true });
    await rm(outside, { force: true });
  }
});

test("query and transformation commands use their independent timeout policies", async () => {
  const fixture = await recoveryFixture({
    queryTimeoutMs: 10,
    transformationTimeoutMs: 1_000,
    loadTimeoutMs: 1_000,
  });
  try {
    const loaded = await fixture.service.loadModule({ modulePath: fixture.modulePath });
    await assert.rejects(
      fixture.service.retrieveGoals({ workspace: loaded.data.workspace }),
      (error: unknown) => error instanceof ApplicationError && error.code === "COMMAND_TIMEOUT",
    );
    const goal = loaded.data.goals[0]?.handle;
    const refined = await fixture.service.refine({ goal: goal as string, expression: "slow-preview" });
    assert.equal(refined.data.edits[0]?.replacement, "x");
  } finally {
    await fixture.service.shutdown();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("separate workspaces make concurrent progress and shutdown all children", async () => {
  const first = await mkdtemp(path.join(tmpdir(), "agda-mcp-concurrent-a-"));
  const second = await mkdtemp(path.join(tmpdir(), "agda-mcp-concurrent-b-"));
  const firstModule = path.join(first, "Tiny.agda");
  const secondModule = path.join(second, "Tiny.agda");
  const source = await readFile("test/fixtures/agda-2.8.0/Tiny.agda");
  await writeFile(firstModule, source);
  await writeFile(secondModule, source);
  const hosts: AgdaProcessHost[] = [];
  const service = await AgdaApplicationService.create(
    parseServerOptions({ workspaceRoots: [first, second], commandTimeoutMs: 2_000 }),
    {
      installation: INSTALLATION,
      processHostFactory: (hostOptions) => {
        const host = new AgdaProcessHost({
          ...hostOptions,
          executable: process.execPath,
          launchArguments: [FAKE_AGDA],
        });
        hosts.push(host);
        return host;
      },
    },
  );
  try {
    const [left, right] = await Promise.all([
      service.loadModule({ modulePath: firstModule }),
      service.loadModule({ modulePath: secondModule }),
    ]);
    const started = performance.now();
    await Promise.all([
      service.retrieveGoals({ workspace: left.data.workspace }),
      service.retrieveGoals({ workspace: right.data.workspace }),
    ]);
    assert.equal(performance.now() - started < 275, true);
  } finally {
    await service.shutdown();
    assert.equal(hosts.length, 2);
    assert.equal(hosts.every((host) => host.state === "stopped"), true);
    await rm(first, { recursive: true, force: true });
    await rm(second, { recursive: true, force: true });
  }
});
