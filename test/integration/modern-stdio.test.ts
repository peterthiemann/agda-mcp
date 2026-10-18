import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import * as z from "zod/v4";

import { ApplicationError } from "../../src/application/errors.js";
import { parseServerOptions } from "../../src/application/config.js";
import { discoverAgdaInstallation } from "../../src/discovery/agdaInstallation.js";

test("modern stdio supports discovery, roots MRTR, queries and incremental proof edits", async (context) => {
  let installation;
  try {
    installation = await discoverAgdaInstallation(parseServerOptions({ workspaceRoots: [process.cwd()] }));
  } catch (error: unknown) {
    if (!(error instanceof ApplicationError) || error.code !== "AGDA_NOT_FOUND") throw error;
    context.skip("Agda is unavailable; live proof integration requires Agda 2.8.0");
    return;
  }
  if (installation.version !== "2.8.0") {
    context.skip(`Agda ${installation.version} is installed; live baseline requires 2.8.0`);
    return;
  }
  const directory = await mkdtemp(path.join(tmpdir(), "agda-modern-proof-"));
  const filename = path.join(directory, "Modern.agda");
  const original = "module Modern where\nidentity : {A : Set} → A → A\nidentity x = ?\n";
  await writeFile(filename, original);
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [path.resolve(".test-dist/src/index.js")], cwd: process.cwd(), stderr: "pipe",
    env: { ...getDefaultEnvironment(), AGDA_MCP_OPTIONS: JSON.stringify({
      agdaExecutable: installation.executable, asyncMode: "never",
    }) },
  });
  const client = new Client({ name: "modern-proof-test", version: "1" }, {
    versionNegotiation: { mode: { pin: "2026-07-28" } }, capabilities: { roots: {} },
  });
  let rootsRequests = 0;
  client.setRequestHandler("roots/list", async () => {
    rootsRequests++;
    return { roots: [{ uri: pathToFileURL(directory).href }] };
  });
  async function call(name: string, args: Record<string, unknown>) {
    let result = await client.callTool({ name, arguments: args });
    for (let attempt = 0; attempt < 10; attempt++) {
      assert.equal(result.isError, undefined, JSON.stringify(result));
      const body = result.structuredContent as Record<string, unknown>;
      if (body.status !== "pending") return body.data as Record<string, unknown>;
      result = await client.callTool({ name: "agda_job_await", arguments: {
        job: (body.job as { id: string }).id, waitMs: 1000,
      } });
    }
    throw new Error("Agda job did not settle");
  }
  try {
    await client.connect(transport);
    assert.equal(client.getProtocolEra(), "modern");
    assert.equal((await client.listTools()).tools.length, 18);
    const skills = await client.request({ method: "skills/list", params: {} }, z.object({
      skills: z.array(z.object({ uri: z.string() })),
    }));
    assert.equal(skills.skills[0]?.uri, "skill://agda-proof/SKILL.md");
    assert.ok((await client.readResource({ uri: skills.skills[0]!.uri })).contents.length);
    const info = await call("agda_server_info", {});
    assert.equal(rootsRequests, 1, "client fulfils input_required roots request before Agda starts");
    assert.deepEqual(info.workspaceRoots, [directory]);
    const loaded = await call("agda_load_module", { modulePath: filename, includeContexts: true, async: true });
    assert.equal(loaded.checked, true);
    const goal = (loaded.goals as { handle: string }[])[0]!.handle;
    const inferred = await call("agda_infer_type", { goal, expression: "x" });
    assert.equal(inferred.type, "A");
    const preview = await call("agda_refine", { goal, expression: "x", apply: false });
    assert.equal(preview.applied, false);
    assert.equal(await readFile(filename, "utf8"), original);
    const fresh = (preview.goals as { handle: string }[])[0]!.handle;
    const applied = await call("agda_refine", { goal: fresh, expression: "x", apply: true });
    assert.equal(applied.applied, true);
    assert.equal(applied.checked, true);
    assert.deepEqual(applied.goals, []);
    assert.match(await readFile(filename, "utf8"), /identity x = x/u);
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("modern stdio exits on stdin EOF after starting a deferred Agda operation", { timeout: 10_000 }, async () => {
  const { spawn } = await import("node:child_process");
  const directory = await mkdtemp(path.join(tmpdir(), "agda-modern-eof-"));
  const filename = path.join(directory, "Eof.agda");
  await writeFile(filename, "module Eof where\nx : Set₁\nx = Set\n");
  const child = spawn(process.execPath, [path.resolve(".test-dist/src/index.js"), "--dynamic-workspaces"], {
    cwd: process.cwd(), env: { ...getDefaultEnvironment(), AGDA_MCP_OPTIONS: "{}" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
  try {
    const pending = new Promise<void>((resolve, reject) => {
      let buffered = "";
      child.stdout.on("data", (chunk: Buffer) => {
        buffered += chunk.toString("utf8");
        let newline;
        while ((newline = buffered.indexOf("\n")) !== -1) {
          const frame = JSON.parse(buffered.slice(0, newline)) as { error?: unknown; result?: { structuredContent?: { status?: string } } };
          buffered = buffered.slice(newline + 1);
          if (frame.error) reject(new Error(JSON.stringify(frame.error)));
          if (frame.result?.structuredContent?.status === "pending") resolve();
        }
      });
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
      name: "agda_load_module", arguments: { modulePath: filename, workspaceRoot: directory, async: true },
      _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} },
    } }) + "\n");
    await pending;
    child.stdin.end();
    assert.equal(await exited, 0);
  } finally {
    if (child.exitCode === null) { child.kill("SIGKILL"); await exited; }
    await rm(directory, { recursive: true, force: true });
  }
});
