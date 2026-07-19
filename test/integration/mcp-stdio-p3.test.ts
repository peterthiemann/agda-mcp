import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";

import { parseServerOptions } from "../../src/application/config.js";
import { ApplicationError } from "../../src/application/errors.js";
import { discoverAgdaInstallation } from "../../src/discovery/agdaInstallation.js";

test("the compiled CLI serves the P3 tools over clean stdio framing", async (context) => {
  const fixtureRoot = path.resolve("test/fixtures/agda-2.8.0");
  const options = parseServerOptions({ workspaceRoots: [fixtureRoot], commandTimeoutMs: 120_000 });
  let installation;
  try {
    installation = await discoverAgdaInstallation(options);
  } catch (error: unknown) {
    const code = error instanceof ApplicationError ? error.code : "unknown";
    context.skip(`Agda is unavailable (${code})`);
    return;
  }
  if (installation.version !== "2.8.0") {
    context.skip(`Agda ${installation.version} is installed; live baseline requires 2.8.0`);
    return;
  }

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve(".test-dist/src/index.js")],
    cwd: process.cwd(),
    stderr: "pipe",
    env: {
      ...getDefaultEnvironment(),
      AGDA_MCP_OPTIONS: JSON.stringify({
        agdaExecutable: installation.executable,
        workspaceRoots: [fixtureRoot],
        commandTimeoutMs: 120_000,
      }),
    },
  });
  const stderr: Buffer[] = [];
  transport.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
  const client = new Client({ name: "agda-mcp-stdio-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name).sort(),
      ["agda_load_module", "agda_server_info", "agda_typecheck"],
    );
    const loaded = await client.callTool({
      name: "agda_load_module",
      arguments: { modulePath: path.join(fixtureRoot, "Tiny.agda") },
    });
    assert.equal(loaded.isError, undefined);
    const workspace = (loaded.structuredContent as { data?: { workspace?: string } } | undefined)
      ?.data?.workspace;
    assert.equal(typeof workspace, "string");
    const checked = await client.callTool({
      name: "agda_typecheck",
      arguments: { workspace },
    });
    assert.equal(checked.isError, undefined);
    assert.equal(Buffer.concat(stderr).toString("utf8"), "");
  } finally {
    await client.close();
  }
});
