import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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
const FIXTURE_ROOT = path.resolve("test/fixtures/agda-2.8.0");
const INSTALLATION: AgdaInstallation = Object.freeze({
  executable: process.execPath,
  version: "2.8.0",
  applicationDirectory: "/app",
  dataDirectory: "/data",
  adapter: "agda-2.8.0",
  compatibility: "supported",
  warnings: Object.freeze([]),
});

test("the MCP SDK lists the complete surface and invokes the first vertical slice", async () => {
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
  const server = createAgdaMcpServer(async () => service);
  const client = new Client({ name: "agda-mcp-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((tool) => tool.name).sort(),
      [
        "agda_auto",
        "agda_case_split",
        "agda_infer_type",
        "agda_job_await",
        "agda_job_await_any",
        "agda_job_cancel",
        "agda_job_list",
        "agda_job_status",
        "agda_load_module",
        "agda_normalize_expression",
        "agda_query_metavariables",
        "agda_refine",
        "agda_retrieve_constraints",
        "agda_retrieve_context",
        "agda_retrieve_contexts",
        "agda_retrieve_goals",
        "agda_server_info",
        "agda_typecheck",
      ],
    );

    const info = await client.callTool({ name: "agda_server_info", arguments: {} });
    assert.equal(info.isError, undefined);
    const loaded = await client.callTool({
      name: "agda_load_module",
      arguments: { modulePath: path.join(FIXTURE_ROOT, "Tiny.agda") },
    });
    assert.equal(loaded.isError, undefined);
    const structured = loaded.structuredContent as { data?: { workspace?: string } } | undefined;
    const workspace = structured?.data?.workspace;
    assert.equal(typeof workspace, "string");
    const checked = await client.callTool({
      name: "agda_typecheck",
      arguments: { workspace },
    });
    assert.equal(checked.isError, undefined);
  } finally {
    await client.close();
    await server.close();
    await service.shutdown();
  }
});

test("a dynamic server opens a model-selected workspace outside configured roots", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "agda-mcp-dynamic-mcp-"));
  const modulePath = path.join(directory, "Tiny.agda");
  await writeFile(modulePath, await readFile(path.join(FIXTURE_ROOT, "Tiny.agda")));
  const service = await AgdaApplicationService.create(
    parseServerOptions({
      workspaceRoots: [FIXTURE_ROOT],
      allowDynamicWorkspaces: true,
      commandTimeoutMs: 2_000,
    }),
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
  const server = createAgdaMcpServer(async () => service);
  const client = new Client({ name: "agda-mcp-dynamic-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const info = await client.callTool({ name: "agda_server_info", arguments: {} });
    assert.equal(
      (info.structuredContent as {
        data?: { capabilities?: { workspaceSelection?: string } };
      } | undefined)?.data?.capabilities?.workspaceSelection,
      "request",
    );

    const loaded = await client.callTool({
      name: "agda_load_module",
      arguments: { modulePath, workspaceRoot: directory },
    });
    assert.equal(loaded.isError, undefined);
    assert.equal(
      (loaded.structuredContent as { data?: { workspaceRoot?: string } } | undefined)?.data
        ?.workspaceRoot,
      await realpath(directory),
    );
  } finally {
    await client.close();
    await server.close();
    await service.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});
