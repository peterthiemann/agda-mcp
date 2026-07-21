import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { parseServerOptions } from "../../src/application/config.js";
import { ApplicationError } from "../../src/application/errors.js";
import { AgdaApplicationService } from "../../src/application/service.js";
import type { AgdaInstallation } from "../../src/discovery/agdaInstallation.js";
import { AgdaProcessHost } from "../../src/protocol/processHost.js";

const FAKE_AGDA = path.resolve("test/fixtures/process-host/fake-agda.mjs");
const RESTORE_FAILURE = path.resolve("test/fixtures/process-host/fake-agda-restore-failure.mjs");
const INSTALLATION: AgdaInstallation = Object.freeze({
  executable: process.execPath,
  version: "2.8.0",
  applicationDirectory: "/app",
  dataDirectory: "/data",
  adapter: "agda-2.8.0",
  compatibility: "supported",
  warnings: Object.freeze([]),
});

async function fixture(fake: string = FAKE_AGDA) {
  const directory = await mkdtemp(path.join(tmpdir(), "agda-mcp-preview-"));
  const modulePath = path.join(directory, "Tiny.agda");
  await writeFile(modulePath, await readFile("test/fixtures/agda-2.8.0/Tiny.agda"));
  const service = await AgdaApplicationService.create(
    parseServerOptions({ workspaceRoots: [directory], commandTimeoutMs: 2_000 }),
    {
      installation: INSTALLATION,
      processHostFactory: (options) =>
        new AgdaProcessHost({
          ...options,
          executable: process.execPath,
          launchArguments: [fake],
        }),
    },
  );
  return { directory, modulePath, service };
}

test("transformation previews preserve bytes, restore state, and rotate handles", async () => {
  const testFixture = await fixture();
  try {
    const before = await readFile(testFixture.modulePath);
    const loaded = await testFixture.service.loadModule({ modulePath: testFixture.modulePath });
    const goal = loaded.data.goals[0]?.handle;
    assert.notEqual(goal, undefined);
    const preview = await testFixture.service.refine({ goal: goal as string, expression: "x" });
    assert.deepEqual(await readFile(testFixture.modulePath), before);
    assert.equal(preview.data.applied, false);
    assert.equal(preview.data.checked, true);
    assert.equal(preview.data.sourceFingerprint, loaded.data.sourceFingerprint);
    assert.equal(preview.data.restoredRevision, loaded.data.revision + 1);
    assert.equal(preview.data.edits[0]?.replacement, "x");
    assert.equal(preview.data.edits[0]?.expectedSourceFingerprint, loaded.data.sourceFingerprint);
    // The restore reload starts a new generation, so the prior handle is gone.
    assert.notEqual(preview.data.goals[0]?.handle, goal);
    assert.notEqual(preview.raw.restore, undefined);
    assert.equal(preview.raw.typecheck, undefined);
    assert.equal(preview.raw.events.some((event) => (event as { kind?: unknown }).kind === "GiveAction"), true);
    await assert.rejects(
      testFixture.service.refine({ goal: goal as string }),
      (error: unknown) => error instanceof ApplicationError && error.code === "STALE_GOAL_HANDLE",
    );

    const restoredGoal = preview.data.goals[0]?.handle;
    assert.notEqual(restoredGoal, undefined);
    const auto = await testFixture.service.auto({ goal: restoredGoal as string });
    assert.equal(auto.data.found, true);
    assert.equal(auto.data.edits[0]?.replacement, "x");

    const caseGoal = auto.data.goals[0]?.handle;
    assert.notEqual(caseGoal, undefined);
    const split = await testFixture.service.caseSplit({ goal: caseGoal as string, variables: "x" });
    assert.equal(split.data.edits[0]?.replacement, "id true = false\nid false = true");
    assert.deepEqual(await readFile(testFixture.modulePath), before);
  } finally {
    await testFixture.service.shutdown();
    await rm(testFixture.directory, { recursive: true, force: true });
  }
});

test("an opted-in direct edit is atomically applied and typechecked in one transaction", async () => {
  const testFixture = await fixture();
  try {
    const loaded = await testFixture.service.loadModule({ modulePath: testFixture.modulePath });
    const goal = loaded.data.goals[0]?.handle;
    assert.notEqual(goal, undefined);
    const applied = await testFixture.service.caseSplit({
      goal: goal as string,
      variables: "x",
      apply: true,
    });
    const source = await readFile(testFixture.modulePath, "utf8");
    assert.match(source, /id true = false\nid false = true/u);
    assert.equal(applied.data.applied, true);
    assert.equal(applied.data.checked, true);
    assert.deepEqual(applied.data.diagnostics, []);
    assert.equal(
      applied.data.sourceFingerprint,
      createHash("sha256").update(source).digest("hex"),
    );
    assert.equal(applied.data.restoredRevision, loaded.data.revision + 1);
    assert.notEqual(applied.data.goals[0]?.handle, goal);
    assert.notEqual(applied.raw.typecheck, undefined);
    assert.equal(applied.raw.restore, undefined);
  } finally {
    await testFixture.service.shutdown();
    await rm(testFixture.directory, { recursive: true, force: true });
  }
});

test("a source race prevents an opted-in direct edit from overwriting external changes", async () => {
  const testFixture = await fixture();
  try {
    const loaded = await testFixture.service.loadModule({ modulePath: testFixture.modulePath });
    const goal = loaded.data.goals[0]?.handle;
    assert.notEqual(goal, undefined);
    const pending = testFixture.service.refine({
      goal: goal as string,
      expression: "slow-preview",
      apply: true,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    const externallyChanged = `${await readFile(testFixture.modulePath, "utf8")}\n-- external\n`;
    await writeFile(testFixture.modulePath, externallyChanged);
    await assert.rejects(
      pending,
      (error: unknown) => error instanceof ApplicationError && error.code === "SOURCE_CHANGED",
    );
    assert.equal(await readFile(testFixture.modulePath, "utf8"), externallyChanged);
  } finally {
    await testFixture.service.shutdown();
    await rm(testFixture.directory, { recursive: true, force: true });
  }
});

test("a rejected proposal still reloads and rotates the goal state", async () => {
  const testFixture = await fixture();
  try {
    const before = await readFile(testFixture.modulePath);
    const loaded = await testFixture.service.loadModule({ modulePath: testFixture.modulePath });
    const goal = loaded.data.goals[0]?.handle;
    assert.notEqual(goal, undefined);
    await assert.rejects(
      testFixture.service.refine({ goal: goal as string, expression: "reject-preview" }),
      (error: unknown) => error instanceof ApplicationError && error.code === "AGDA_COMMAND_REJECTED",
    );
    assert.deepEqual(await readFile(testFixture.modulePath), before);
    const info = await testFixture.service.serverInfo();
    assert.equal(info.data.workspaces[0]?.revision, loaded.data.revision + 1);
    assert.equal(info.data.workspaces[0]?.lifecycle, "ready");
    // The reload after rejection also starts a new generation.
    await assert.rejects(
      testFixture.service.auto({ goal: goal as string }),
      (error: unknown) => error instanceof ApplicationError && error.code === "STALE_GOAL_HANDLE",
    );
  } finally {
    await testFixture.service.shutdown();
    await rm(testFixture.directory, { recursive: true, force: true });
  }
});

test("a source change during preview rejects the proposal after restoring current disk state", async () => {
  const testFixture = await fixture();
  try {
    const loaded = await testFixture.service.loadModule({ modulePath: testFixture.modulePath });
    const goal = loaded.data.goals[0]?.handle;
    assert.notEqual(goal, undefined);
    const pending = testFixture.service.refine({ goal: goal as string, expression: "slow-preview" });
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    await writeFile(testFixture.modulePath, `${await readFile(testFixture.modulePath, "utf8")}\n-- external\n`);
    await assert.rejects(
      pending,
      (error: unknown) => error instanceof ApplicationError && error.code === "SOURCE_CHANGED",
    );
    // The bytes on disk changed, so the pre-change handle must NOT come back.
    await assert.rejects(
      testFixture.service.auto({ goal: goal as string }),
      (error: unknown) => error instanceof ApplicationError && error.code === "STALE_GOAL_HANDLE",
    );
  } finally {
    await testFixture.service.shutdown();
    await rm(testFixture.directory, { recursive: true, force: true });
  }
});

test("restore failure stops and invalidates the session", async () => {
  const testFixture = await fixture(RESTORE_FAILURE);
  try {
    const loaded = await testFixture.service.loadModule({ modulePath: testFixture.modulePath });
    const goal = loaded.data.goals[0]?.handle;
    assert.notEqual(goal, undefined);
    await assert.rejects(
      testFixture.service.refine({ goal: goal as string, expression: "x" }),
      (error: unknown) => error instanceof ApplicationError && error.code === "RESTORE_FAILED",
    );
    await assert.rejects(
      testFixture.service.refine({ goal: goal as string }),
      (error: unknown) => error instanceof ApplicationError && error.code === "STALE_GOAL_HANDLE",
    );
    const info = await testFixture.service.serverInfo();
    assert.equal(info.data.workspaces[0]?.lifecycle, "stopped");
    assert.equal(info.data.workspaces[0]?.activeModule, undefined);
  } finally {
    await testFixture.service.shutdown();
    await rm(testFixture.directory, { recursive: true, force: true });
  }
});

test("a direct edit is rolled back when its canonical typecheck cannot complete", async () => {
  const testFixture = await fixture(RESTORE_FAILURE);
  try {
    const before = await readFile(testFixture.modulePath);
    const loaded = await testFixture.service.loadModule({ modulePath: testFixture.modulePath });
    const goal = loaded.data.goals[0]?.handle;
    assert.notEqual(goal, undefined);
    await assert.rejects(
      testFixture.service.refine({ goal: goal as string, expression: "x", apply: true }),
      (error: unknown) =>
        error instanceof ApplicationError &&
        error.code === "RESTORE_FAILED" &&
        error.details?.rolledBack === true,
    );
    assert.deepEqual(await readFile(testFixture.modulePath), before);
    const info = await testFixture.service.serverInfo();
    assert.equal(info.data.workspaces[0]?.lifecycle, "ready");
    assert.equal(path.basename(info.data.workspaces[0]?.activeModule ?? ""), "Tiny.agda");
  } finally {
    await testFixture.service.shutdown();
    await rm(testFixture.directory, { recursive: true, force: true });
  }
});
