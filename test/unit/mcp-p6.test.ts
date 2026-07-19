import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { AgdaService } from "../../src/application/agdaService.js";
import type { NormalizedResult } from "../../src/application/domain.js";
import { APPLICATION_ERROR_CODES, ApplicationError } from "../../src/application/errors.js";
import {
  applicationErrorPayload,
  createAgdaMcpServer,
} from "../../src/mcp/stdioServer.js";

const EMPTY_RAW = Object.freeze({
  adapter: "test",
  events: Object.freeze([]),
  complete: true,
  capturedBytes: 0,
  totalBytes: 0,
  omittedEventCount: 0,
  stderr: Object.freeze({
    chunks: Object.freeze([]),
    complete: true,
    capturedBytes: 0,
    totalBytes: 0,
  }),
});

function ok(data: unknown): NormalizedResult<unknown> {
  return Object.freeze({ data, warnings: Object.freeze([]), raw: EMPTY_RAW });
}

function recordingService(calls: string[]): AgdaService {
  return new Proxy({} as AgdaService, {
    get(_target, property) {
      if (property === "then") return undefined;
      if (property === "shutdown") return async () => undefined;
      return async (...args: unknown[]) => {
        calls.push(String(property));
        return ok({ operation: property, args });
      };
    },
  });
}

test("all twelve strict schemas dispatch to their transport-independent service operations", async () => {
  const calls: string[] = [];
  const server = createAgdaMcpServer(async () => recordingService(calls));
  const client = new Client({ name: "agda-mcp-p6", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const invocations = [
      ["agda_server_info", {}],
      ["agda_load_module", { modulePath: "/workspace/M.agda" }],
      ["agda_typecheck", { workspace: "workspace" }],
      ["agda_retrieve_goals", { workspace: "workspace" }],
      ["agda_retrieve_context", { goal: "goal", rewrite: "simplified" }],
      ["agda_retrieve_constraints", { workspace: "workspace" }],
      ["agda_case_split", { goal: "goal", variables: "x" }],
      ["agda_refine", { goal: "goal", expression: "x", usePatternLambda: false }],
      ["agda_auto", { goal: "goal", query: "-t 5" }],
      ["agda_normalize_expression", { goal: "goal", expression: "x", mode: "default" }],
      ["agda_infer_type", { workspace: "workspace", expression: "x", rewrite: "as_is" }],
      ["agda_query_metavariables", { workspace: "workspace" }],
    ] as const;
    for (const [name, args] of invocations) {
      const response = await client.callTool(
        { name, arguments: args },
        undefined,
        { timeout: 2_000 },
      ).catch((error: unknown) => {
        throw new Error(`Invocation failed: ${name}`, { cause: error });
      });
      assert.equal(response.isError, undefined, name);
      assert.notEqual(response.structuredContent, undefined, name);
    }
    assert.deepEqual(calls, [
      "serverInfo",
      "loadModule",
      "typecheck",
      "retrieveGoals",
      "retrieveContext",
      "retrieveConstraints",
      "caseSplit",
      "refine",
      "auto",
      "normalizeExpression",
      "inferType",
      "queryMetavariables",
    ]);

    const invalid = await client.callTool({
      name: "agda_normalize_expression",
      arguments: { workspace: "workspace", goal: "goal", expression: "x" },
    });
    assert.equal(invalid.isError, true);
    assert.equal(calls.length, 12, "invalid input reached the application service");
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP cancellation reaches the application operation signal", async () => {
  let observed: AbortSignal | undefined;
  const service = new Proxy({} as AgdaService, {
    get(_target, property) {
      if (property === "then") return undefined;
      if (property !== "loadModule") return async () => ok({});
      return async (_request: unknown, context: { signal?: AbortSignal }) =>
        new Promise<NormalizedResult<unknown>>((_resolve, reject) => {
          observed = context.signal;
          context.signal?.addEventListener(
            "abort",
            () => reject(new ApplicationError("AGDA_COMMAND_REJECTED", "cancelled")),
            { once: true },
          );
        });
    },
  });
  const server = createAgdaMcpServer(async () => service);
  const client = new Client({ name: "agda-mcp-cancel", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const controller = new AbortController();
    const pending = client.callTool(
      { name: "agda_load_module", arguments: { modulePath: "/workspace/M.agda" } },
      undefined,
      { signal: controller.signal },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort();
    await assert.rejects(
      pending,
      (error: unknown) => error instanceof Error && error.message.includes("AbortError"),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(observed?.aborted, true);
  } finally {
    await client.close();
    await server.close();
  }
});

test("every application error maps to a bounded payload with recovery guidance", () => {
  for (const code of APPLICATION_ERROR_CODES) {
    const payload = applicationErrorPayload(new ApplicationError(code, `message-${code}`));
    assert.equal(payload.code, code);
    assert.equal(payload.message, `message-${code}`);
    assert.equal(payload.guidance.length > 0, true);
    assert.equal("stack" in payload, false);
  }
  const unexpected = applicationErrorPayload(new Error("secret implementation detail"));
  assert.equal(unexpected.code, "AGDA_COMMAND_REJECTED");
  assert.equal(unexpected.message.includes("secret implementation detail"), false);
  assert.equal(unexpected.recoverable, false);
});
