import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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

test("the compiled CLI serves the full tool surface over clean stdio framing", async (context) => {
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
    const goalsPath = path.join(fixtureRoot, "formats", "Goals.agda");
    const goalsBefore = await readFile(goalsPath);
    const loaded = await client.callTool({
      name: "agda_load_module",
      arguments: { modulePath: goalsPath },
    });
    assert.equal(loaded.isError, undefined);
    const workspace = (loaded.structuredContent as { data?: { workspace?: string } } | undefined)
      ?.data?.workspace;
    assert.equal(typeof workspace, "string");
    let goal = (loaded.structuredContent as { data?: { goals?: Array<{ handle?: string }> } } | undefined)
      ?.data?.goals?.[0]?.handle;
    assert.equal(typeof goal, "string");

    const checked = await client.callTool({
      name: "agda_typecheck",
      arguments: { workspace },
    });
    assert.equal(checked.isError, undefined);
    goal = (checked.structuredContent as { data?: { goals?: Array<{ handle?: string }> } } | undefined)
      ?.data?.goals?.[0]?.handle;
    assert.equal(typeof goal, "string");

    for (const [name, argumentsValue] of [
      ["agda_retrieve_goals", { workspace }],
      ["agda_retrieve_context", { goal }],
      ["agda_retrieve_constraints", { workspace }],
      ["agda_normalize_expression", { goal, expression: "x" }],
      ["agda_infer_type", { workspace, expression: "id" }],
      ["agda_query_metavariables", { workspace }],
    ] as const) {
      const response = await client.callTool({ name, arguments: argumentsValue });
      assert.equal(response.isError, undefined, name);
      assert.notEqual(response.structuredContent, undefined, name);
    }

    const refine = await client.callTool({
      name: "agda_refine",
      arguments: { goal, expression: "x" },
    });
    assert.equal(refine.isError, undefined);
    const originalGoal = goal;
    goal = (refine.structuredContent as { data?: { goals?: Array<{ handle?: string }> } } | undefined)
      ?.data?.goals?.[0]?.handle;
    assert.equal(typeof goal, "string");
    const auto = await client.callTool({ name: "agda_auto", arguments: { goal } });
    assert.equal(auto.isError, undefined);

    // The preview's restore reload rotates handles, so the prior one is stale.
    assert.notEqual(originalGoal, goal);
    const stale = await client.callTool({
      name: "agda_retrieve_context",
      arguments: { goal: originalGoal },
    });
    assert.equal(stale.isError, true);
    assert.equal(
      typeof (stale.structuredContent as { guidance?: unknown } | undefined)?.guidance,
      "string",
    );
    assert.deepEqual(
      await readFile(goalsPath),
      goalsBefore,
    );

    const casePath = path.join(fixtureRoot, "formats", "CaseSplit.agda");
    const caseBefore = await readFile(casePath);
    const caseLoaded = await client.callTool({
      name: "agda_load_module",
      arguments: { modulePath: casePath },
    });
    const caseGoal = (caseLoaded.structuredContent as { data?: { goals?: Array<{ handle?: string }> } } | undefined)
      ?.data?.goals?.[0]?.handle;
    assert.equal(typeof caseGoal, "string");
    const split = await client.callTool({
      name: "agda_case_split",
      arguments: { goal: caseGoal, variables: "x" },
    });
    assert.equal(split.isError, undefined);
    assert.deepEqual(
      await readFile(casePath),
      caseBefore,
    );

    const invalid = await client.callTool({
      name: "agda_typecheck",
      arguments: { workspace, unexpected: true },
    });
    assert.equal(invalid.isError, true);
    assert.equal(Buffer.concat(stderr).toString("utf8"), "");
  } finally {
    await client.close();
  }
});

test("the compiled dynamic mutation server opens a selected workspace and applies edits", async (context) => {
  const fixtureRoot = path.resolve("test/fixtures/agda-2.8.0");
  const directory = await mkdtemp(path.join(tmpdir(), "agda-mcp-stdio-write-"));
  const modulePath = path.join(directory, "CaseSplit.agda");
  await writeFile(
    modulePath,
    await readFile(path.join(fixtureRoot, "formats", "CaseSplit.agda")),
  );
  const before = await readFile(modulePath);
  let installation;
  try {
    installation = await discoverAgdaInstallation(parseServerOptions());
  } catch (error: unknown) {
    const code = error instanceof ApplicationError ? error.code : "unknown";
    await rm(directory, { recursive: true, force: true });
    context.skip(`Agda is unavailable (${code})`);
    return;
  }
  if (installation.version !== "2.8.0") {
    await rm(directory, { recursive: true, force: true });
    context.skip(`Agda ${installation.version} is installed; live baseline requires 2.8.0`);
    return;
  }

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      path.resolve(".test-dist/src/index.js"),
      "--dynamic-workspaces",
      "--apply-edits",
    ],
    cwd: process.cwd(),
    stderr: "pipe",
    env: {
      ...getDefaultEnvironment(),
      AGDA_MCP_OPTIONS: JSON.stringify({
        agdaExecutable: installation.executable,
        commandTimeoutMs: 120_000,
        allowDynamicWorkspaces: false,
        applyEditsByDefault: false,
      }),
    },
  });
  const client = new Client({ name: "agda-mcp-stdio-write-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const info = await client.callTool({ name: "agda_server_info", arguments: {} });
    assert.equal(
      (info.structuredContent as {
        data?: { capabilities?: { transformationDefault?: string } };
      } | undefined)?.data?.capabilities?.transformationDefault,
      "apply",
    );
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
    const goal = (loaded.structuredContent as {
      data?: { goals?: Array<{ handle?: string }> };
    } | undefined)?.data?.goals?.[0]?.handle;
    assert.equal(typeof goal, "string");
    const split = await client.callTool({
      name: "agda_case_split",
      arguments: { goal, variables: "x" },
    });
    assert.equal(split.isError, undefined);
    assert.equal(
      (split.structuredContent as { data?: { applied?: boolean; checked?: boolean } } | undefined)
        ?.data?.applied,
      true,
    );
    assert.equal(
      (split.structuredContent as { data?: { applied?: boolean; checked?: boolean } } | undefined)
        ?.data?.checked,
      true,
    );
    assert.notDeepEqual(await readFile(modulePath), before);
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});
