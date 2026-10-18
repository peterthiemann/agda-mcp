import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryTransport, type JSONRPCMessage } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

import type { AgdaService } from "../../src/application/agdaService.js";
import { checkRequestVersions } from "../../src/mcp/modernTransport.js";
import { createAgdaMcpServer } from "../../src/mcp/stdioServer.js";

const META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "raw-modern-test", version: "1" },
  "io.modelcontextprotocol/clientCapabilities": {},
};
const raw = { adapter: "test", events: [], complete: true, capturedBytes: 0, totalBytes: 0,
  omittedEventCount: 0, stderr: { chunks: [], complete: true, capturedBytes: 0, totalBytes: 0 } };

function harness(service: AgdaService) {
  const [peer, transport] = InMemoryTransport.createLinkedPair();
  const frames: Record<string, unknown>[] = [];
  let id = 0;
  const waiters = new Map<number, (frame: Record<string, unknown>) => void>();
  peer.onmessage = (message: JSONRPCMessage) => {
    const frame = message as Record<string, unknown>;
    frames.push(frame);
    if (typeof frame.id === "number") waiters.get(frame.id)?.(frame);
  };
  const handle = serveStdio(() => createAgdaMcpServer(async () => service), { transport: checkRequestVersions(transport) });
  return {
    frames, peer,
    async request(method: string, params: Record<string, unknown> = {}, meta: Record<string, unknown> | null = META) {
      const requestId = ++id;
      const reply = new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => { waiters.delete(requestId); reject(new Error(`Timed out: ${method}`)); }, 2000);
        waiters.set(requestId, (frame) => { clearTimeout(timer); waiters.delete(requestId); resolve(frame); });
      });
      await peer.send({ jsonrpc: "2.0", id: requestId, method,
        params: { ...params, ...(meta === null ? {} : { _meta: meta }) } });
      return reply;
    },
    async close() { await handle.close(); await peer.close(); },
  };
}

function data(result: Record<string, unknown>) {
  assert.equal(result.error, undefined, JSON.stringify(result.error));
  return result.result as Record<string, unknown>;
}

const noAgda = new Proxy({} as AgdaService, { get() { throw new Error("Discovery must not need Agda"); } });

test("modern discovery works without initialize and encodes complete/cacheable results", async () => {
  const wire = harness(noAgda);
  try {
    const discovered = data(await wire.request("server/discover"));
    assert.equal(discovered.resultType, "complete");
    assert.ok((discovered.supportedVersions as string[]).includes("2026-07-28"));
    assert.ok(discovered.capabilities);
    assert.ok(discovered._meta);
    assert.equal(typeof discovered.ttlMs, "number");
    assert.equal(typeof discovered.cacheScope, "string");
    const listed = data(await wire.request("tools/list"));
    assert.equal(listed.resultType, "complete");
    assert.equal((listed.tools as unknown[]).length, 18);
    assert.equal(typeof listed.ttlMs, "number");
    const resources = data(await wire.request("resources/list"));
    assert.equal(resources.resultType, "complete");
    assert.equal(typeof resources.ttlMs, "number");
    const skills = data(await wire.request("skills/list"));
    assert.equal(skills.resultType, "complete");
    const skill = (skills.skills as { uri: string }[])[0]!;
    assert.equal(skill.uri, "skill://agda-proof/SKILL.md");
    const read = data(await wire.request("resources/read", { uri: skill.uri }));
    assert.equal(read.resultType, "complete");
    assert.equal(typeof read.ttlMs, "number");
    assert.deepEqual(data(await wire.request("skills/get", { uri: skill.uri })).skill, skill);
    assert.ok(!wire.frames.some((frame) => "method" in frame), "modern server must not initiate requests or unsolicited notifications");
  } finally { await wire.close(); }
});

test("modern requests validate their own version and capabilities rather than inheriting prior metadata", async () => {
  const wire = harness(noAgda);
  try {
    await wire.request("server/discover");
    await wire.request("tools/list"); // select the modern era after the discovery probe
    for (const method of ["tools/list", "skills/list", "resources/list"]) {
      const response = await wire.request(method, {}, null);
      assert.equal((response.error as { code: number }).code, -32602);
    }
    const missing = await wire.request("skills/list", {}, { "io.modelcontextprotocol/protocolVersion": "2026-07-28" });
    assert.equal((missing.error as { code: number }).code, -32602);
    const unsupported = await wire.request("tools/list", {}, { ...META, "io.modelcontextprotocol/protocolVersion": "2099-01-01" });
    assert.equal((unsupported.error as { code: number }).code, -32022);
    assert.ok((unsupported.error as { data: { supported: string[] } }).data.supported.includes("2026-07-28"));
    const withoutInfo = { ...META } as Record<string, unknown>;
    delete withoutInfo["io.modelcontextprotocol/clientInfo"];
    assert.equal(data(await wire.request("skills/list", {}, withoutInfo)).resultType, "complete");
    assert.equal((await wire.request("skills/get", { uri: "file:///etc/passwd" })).error !== undefined, true);
  } finally { await wire.close(); }
});

test("modern tool calls and deferred jobs preserve normalized payloads", async () => {
  const service = new Proxy({} as AgdaService, { get(_target, method) {
    if (method === "then") return undefined;
    return async () => ({ data: { operation: method, checked: true, goals: [] }, warnings: [], raw });
  } });
  const wire = harness(service);
  try {
    const call = data(await wire.request("tools/call", { name: "agda_load_module", arguments: {
      modulePath: "/project/Proof.agda", async: true,
    } }));
    assert.equal(call.resultType, "complete");
    const pending = call.structuredContent as { status: string; job: { id: string } };
    assert.equal(pending.status, "pending");
    const collected = data(await wire.request("tools/call", { name: "agda_job_await", arguments: { job: pending.job.id, waitMs: 1000 } }));
    assert.equal(collected.resultType, "complete");
    assert.equal((collected.structuredContent as { data: { checked: boolean } }).data.checked, true);
    assert.ok(!wire.frames.some((frame) => "method" in frame));
  } finally { await wire.close(); }
});


test("modern cancellation aborts active work and suppresses its response", async () => {
  let started!: () => void;
  let aborted!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const cancelled = new Promise<void>((resolve) => { aborted = resolve; });
  const service = new Proxy({} as AgdaService, { get(_target, method) {
    if (method === "then") return undefined;
    return async (_context: { signal: AbortSignal }) => {
      started();
      return new Promise((_resolve, reject) => {
        _context.signal.addEventListener("abort", () => { aborted(); reject(new Error("cancelled")); }, { once: true });
      });
    };
  } });
  const wire = harness(service);
  try {
    await wire.request("tools/list");
    await wire.peer.send({ jsonrpc: "2.0", id: 500, method: "tools/call", params: {
      name: "agda_server_info", arguments: { async: false }, _meta: META,
    } });
    await entered;
    await wire.peer.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 500 } });
    await cancelled;
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(!wire.frames.some((frame) => frame.id === 500));
  } finally { await wire.close(); }
});

test("a modern discovery probe can fall back to a v1-style initialization", async () => {
  const wire = harness(noAgda);
  try {
    assert.equal(data(await wire.request("server/discover")).resultType, "complete");
    const initialized = data(await wire.request("initialize", {
      protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "fallback-client", version: "1" },
    }, null));
    assert.equal(initialized.protocolVersion, "2025-11-25");
    await wire.peer.send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
    const tools = data(await wire.request("tools/list", {}, null));
    assert.equal((tools.tools as unknown[]).length, 18);
    assert.equal(tools.resultType, undefined, "legacy wire response stays legacy");
  } finally { await wire.close(); }
});
