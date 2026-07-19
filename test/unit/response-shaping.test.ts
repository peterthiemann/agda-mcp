import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { parseServerOptions } from "../../src/application/config.js";
import { ApplicationError } from "../../src/application/errors.js";
import { AgdaApplicationService } from "../../src/application/service.js";
import type { AgdaInstallation } from "../../src/discovery/agdaInstallation.js";
import { createAgdaMcpServer } from "../../src/mcp/stdioServer.js";
import { AgdaProcessHost } from "../../src/protocol/processHost.js";

const FAKE_AGDA = path.resolve("test/fixtures/process-host/fake-agda.mjs");
const FAKE_CONTEXTS = path.resolve("test/fixtures/process-host/fake-agda-contexts.mjs");
const FIXTURE_ROOT = path.resolve("test/fixtures/agda-2.8.0");
const MODULE_PATH = path.join(FIXTURE_ROOT, "Tiny.agda");
const INSTALLATION: AgdaInstallation = Object.freeze({
  executable: process.execPath,
  version: "2.8.0",
  applicationDirectory: "/app",
  dataDirectory: "/data",
  adapter: "agda-2.8.0",
  compatibility: "supported",
  warnings: Object.freeze([]),
});

async function connect(fake: string = FAKE_AGDA) {
  const service = await AgdaApplicationService.create(
    parseServerOptions({ workspaceRoots: [FIXTURE_ROOT], commandTimeoutMs: 2_000 }),
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
  const server = createAgdaMcpServer(async () => service);
  const client = new Client({ name: "agda-mcp-shaping-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, service, close: async () => { await client.close(); await service.shutdown(); } };
}

function payload(result: unknown): Record<string, any> {
  const content = (result as { content: Array<{ text: string }> }).content;
  return JSON.parse(content[0]?.text ?? "{}") as Record<string, any>;
}

test("the native event log ships by default and is dropped only on request", async () => {
  const harness = await connect();
  try {
    const full = payload(
      await harness.client.callTool({
        name: "agda_load_module",
        arguments: { modulePath: MODULE_PATH },
      }),
    );
    assert.equal(Array.isArray(full.raw.events), true, "events must ship by default");
    assert.equal(full.raw.eventsOmitted, undefined);

    const lean = payload(
      await harness.client.callTool({
        name: "agda_load_module",
        arguments: { modulePath: MODULE_PATH, includeRaw: false },
      }),
    );
    assert.equal(lean.raw.events, undefined, "includeRaw:false must drop events");
    assert.equal(lean.raw.eventsOmitted, true);
    assert.equal(typeof lean.raw.eventCount, "number");
    // The transcript metadata that describes truncation is still present.
    assert.equal(typeof lean.raw.capturedBytes, "number");
    assert.equal(typeof lean.raw.totalBytes, "number");
    assert.notEqual(lean.raw.stderr, undefined);
    // Normalized data is untouched by the raw policy.
    assert.equal(lean.data.checked, true);
    assert.equal(Array.isArray(lean.data.goals), true);

    assert.equal(full.raw.events.length, lean.raw.eventCount);
  } finally {
    await harness.close();
  }
});

test("includeRawByDefault:false makes omission the server-wide default", async () => {
  const service = await AgdaApplicationService.create(
    parseServerOptions({ workspaceRoots: [FIXTURE_ROOT], commandTimeoutMs: 2_000 }),
    {
      installation: INSTALLATION,
      processHostFactory: (options) =>
        new AgdaProcessHost({
          ...options,
          executable: process.execPath,
          launchArguments: [FAKE_AGDA],
        }),
    },
  );
  const server = createAgdaMcpServer(async () => service, undefined, 0, false);
  const client = new Client({ name: "agda-mcp-raw-default", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = payload(
      await client.callTool({ name: "agda_load_module", arguments: { modulePath: MODULE_PATH } }),
    );
    assert.equal(result.raw.events, undefined);

    // A per-call true still wins over the server default.
    const overridden = payload(
      await client.callTool({
        name: "agda_load_module",
        arguments: { modulePath: MODULE_PATH, includeRaw: true },
      }),
    );
    assert.equal(Array.isArray(overridden.raw.events), true);
  } finally {
    await client.close();
    await service.shutdown();
  }
});

test("diagnosticsOnly drops goals and metavariables but keeps the verdict", async () => {
  const harness = await connect();
  try {
    const full = payload(
      await harness.client.callTool({
        name: "agda_load_module",
        arguments: { modulePath: MODULE_PATH },
      }),
    );
    assert.notEqual(full.data.goals, undefined);

    const diagnostics = payload(
      await harness.client.callTool({
        name: "agda_load_module",
        arguments: { modulePath: MODULE_PATH, diagnosticsOnly: true },
      }),
    );
    assert.equal(diagnostics.data.goals, undefined);
    assert.equal(diagnostics.data.invisibleMetavariables, undefined);
    assert.equal(diagnostics.data.checked, full.data.checked);
    assert.deepEqual(diagnostics.data.diagnostics, full.data.diagnostics);
    assert.equal(diagnostics.data.workspace, full.data.workspace);
  } finally {
    await harness.close();
  }
});

test("batched contexts isolate a bad handle instead of failing the whole call", async () => {
  const harness = await connect(FAKE_CONTEXTS);
  try {
    const loaded = await harness.service.loadModule({ modulePath: MODULE_PATH });
    const goal = loaded.data.goals[0]?.handle;
    assert.notEqual(goal, undefined);

    const batch = await harness.service.retrieveContexts({
      goals: [goal as string, "goal_not-a-real-handle", goal as string],
    });

    assert.equal(batch.data.requested, 3);
    assert.equal(batch.data.succeeded, 2);
    assert.equal(batch.data.failed, 1);
    assert.equal(batch.data.contexts[0]?.ok, true);
    assert.equal(typeof batch.data.contexts[0]?.context?.goalType, "string");
    assert.equal(batch.data.contexts[1]?.ok, false);
    assert.equal(batch.data.contexts[1]?.error?.code, "STALE_GOAL_HANDLE");
    assert.equal(batch.data.contexts[2]?.ok, true);
    // Entries come back in the requested order so the caller can zip them up.
    assert.deepEqual(
      batch.data.contexts.map((entry) => entry.goal),
      [goal, "goal_not-a-real-handle", goal],
    );
  } finally {
    await harness.close();
  }
});

test("a batch is bounded by maxBatchGoals", async () => {
  const service = await AgdaApplicationService.create(
    parseServerOptions({ workspaceRoots: [FIXTURE_ROOT], commandTimeoutMs: 2_000, maxBatchGoals: 3 }),
    {
      installation: INSTALLATION,
      processHostFactory: (options) =>
        new AgdaProcessHost({
          ...options,
          executable: process.execPath,
          launchArguments: [FAKE_CONTEXTS],
        }),
    },
  );
  try {
    const loaded = await service.loadModule({ modulePath: MODULE_PATH });
    const goal = loaded.data.goals[0]?.handle as string;

    await assert.rejects(
      service.retrieveContexts({ goals: [goal, goal, goal, goal] }),
      (error: unknown) =>
        error instanceof ApplicationError &&
        error.code === "INVALID_ARGUMENT" &&
        (error.details as { maxBatchGoals?: number }).maxBatchGoals === 3,
      "a batch over the limit must be refused before any Agda work runs",
    );
    await assert.rejects(
      service.retrieveContexts({ goals: [] }),
      (error: unknown) => error instanceof ApplicationError && error.code === "INVALID_ARGUMENT",
    );
    // At the limit it still works.
    const ok = await service.retrieveContexts({ goals: [goal, goal, goal] });
    assert.equal(ok.data.succeeded, 3);
  } finally {
    await service.shutdown();
  }
});

test("a batch response is re-truncated against one aggregate raw budget", async () => {
  // Sized so the load (~443B) and each individual context command (~181B) fit
  // comfortably, but three contexts merged (~543B) cannot.
  const service = await AgdaApplicationService.create(
    parseServerOptions({
      workspaceRoots: [FIXTURE_ROOT],
      commandTimeoutMs: 2_000,
      rawResponseLimitBytes: 500,
      maxCommandOutputBytes: 1024 * 1024,
    }),
    {
      installation: INSTALLATION,
      processHostFactory: (options) =>
        new AgdaProcessHost({
          ...options,
          executable: process.execPath,
          launchArguments: [FAKE_CONTEXTS],
        }),
    },
  );
  try {
    const loaded = await service.loadModule({ modulePath: MODULE_PATH });
    const goal = loaded.data.goals[0]?.handle as string;
    const batch = await service.retrieveContexts({ goals: [goal, goal, goal] });

    assert.ok(
      batch.raw.capturedBytes <= 500,
      `merged capturedBytes ${batch.raw.capturedBytes} must respect the 500B budget`,
    );
    assert.ok(batch.data.succeeded === 3, "all three goals still resolve");
    assert.ok(batch.raw.omittedEventCount > 0, "the merge must report what it dropped");
    assert.equal(batch.raw.complete, false);
    // Omission evidence is combined, not discarded.
    assert.match(batch.raw.omittedSha256 ?? "", /^[0-9a-f]{64}$/u);
    // Totals still describe everything Agda produced.
    assert.ok(batch.raw.totalBytes >= batch.raw.capturedBytes);
  } finally {
    await service.shutdown();
  }
});

test("a session-wide failure aborts a batch instead of becoming one goal's error", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "agda-mcp-batch-"));
  const modulePath = path.join(directory, "Tiny.agda");
  await writeFile(modulePath, await readFile(MODULE_PATH));
  const service = await AgdaApplicationService.create(
    parseServerOptions({ workspaceRoots: [directory], commandTimeoutMs: 2_000 }),
    {
      installation: INSTALLATION,
      processHostFactory: (options) =>
        new AgdaProcessHost({
          ...options,
          executable: process.execPath,
          launchArguments: [FAKE_CONTEXTS],
        }),
    },
  );
  try {
    const loaded = await service.loadModule({ modulePath });
    const goal = loaded.data.goals[0]?.handle as string;

    // The module changes on disk: SOURCE_CHANGED describes the session, not
    // any one goal, so the whole batch must fail rather than reporting it as
    // the first goal's error and continuing.
    await writeFile(modulePath, `${await readFile(modulePath, "utf8")}\n-- external\n`);
    await assert.rejects(
      service.retrieveContexts({ goals: [goal, goal] }),
      (error: unknown) => error instanceof ApplicationError && error.code === "SOURCE_CHANGED",
    );
  } finally {
    await service.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an aborted batch stops instead of running every remaining goal", async () => {
  const harness = await connect(FAKE_CONTEXTS);
  try {
    const loaded = await harness.service.loadModule({ modulePath: MODULE_PATH });
    const goal = loaded.data.goals[0]?.handle as string;
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      harness.service.retrieveContexts({ goals: [goal, goal] }, { signal: controller.signal }),
    );
  } finally {
    await harness.close();
  }
});
