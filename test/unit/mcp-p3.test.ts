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

test("the MCP SDK lists and invokes the first vertical tool slice", async () => {
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
      ["agda_load_module", "agda_server_info", "agda_typecheck"],
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
