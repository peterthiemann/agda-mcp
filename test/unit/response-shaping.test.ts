import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { parseServerOptions } from "../../src/application/config.js";
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
