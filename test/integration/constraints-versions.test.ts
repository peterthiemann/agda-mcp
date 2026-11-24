import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";

test("explicit Agda executable loads a hole and retrieves constraints over MCP", {
  timeout: 120_000,
}, async (context) => {
  const executable = process.env.AGDA_TEST_EXECUTABLE;
  if (executable === undefined) {
    context.skip("Set AGDA_TEST_EXECUTABLE to an isolated official Agda 2.8.0 or 2.9.0 executable");
    return;
  }
  assert.ok(path.isAbsolute(executable), "Agda executable must be selected explicitly");
  const version = process.env.AGDA_TEST_VERSION;
  assert.ok(version === "2.8.0" || version === "2.9.0", "Set AGDA_TEST_VERSION to 2.8.0 or 2.9.0");
  const directory = await mkdtemp(path.join(tmpdir(), "agda-constraints-"));
  const modulePath = path.join(directory, "Constraints.agda");
  await writeFile(modulePath, "module Constraints where\nidentity : {A : Set} → A → A\nidentity x = ?\n");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve(".test-dist/src/index.js")],
    cwd: process.cwd(),
    stderr: "pipe",
    env: { ...getDefaultEnvironment(), AGDA_MCP_OPTIONS: JSON.stringify({
      agdaExecutable: executable, workspaceRoots: [directory], asyncMode: "never",
      commandTimeoutMs: 90_000,
    }) },
  });
  const client = new Client({ name: "constraints-version-test", version: "1" });
  async function call(name: string, arguments_: Record<string, unknown>) {
    const result = await client.callTool({ name, arguments: arguments_ });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    const body = result.structuredContent as { data: Record<string, unknown> };
    assert.ok(body.data, JSON.stringify(result));
    return body.data;
  }
  try {
    await client.connect(transport);
    const info = await call("agda_server_info", {});
    const agda = info.agda as { version: string; adapter: string; compatibility: string };
    assert.match(agda.version, new RegExp(`^${version.replaceAll(".", "\\.")}(?:-[0-9a-f]{7,40})?$`));
    assert.equal(agda.adapter, `agda-${version}`);
    assert.equal(agda.compatibility, agda.version === "2.8.0" ? "supported" : "unverified");
    const loaded = await call("agda_load_module", { modulePath });
    assert.equal(loaded.checked, true);
    assert.equal((loaded.goals as unknown[]).length, 1);
    const constraints = await call("agda_retrieve_constraints", { workspace: loaded.workspace });
    assert.deepEqual(constraints.constraints, []);
    context.diagnostic(`Agda ${version}: loaded one hole and retrieved constraints successfully`);
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});
