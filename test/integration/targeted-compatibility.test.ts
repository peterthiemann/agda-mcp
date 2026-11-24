import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import type {
  AutoResult, ContextResult, ContextsResult, EditPreviewResult, GoalsResult,
  InferredTypeResult, MetavariablesResult, ModuleCheckResult, NormalizedExpressionResult,
} from "../../src/application/domain.js";

interface Harness {
  readonly version: "2.8.0" | "2.9.0";
  file(name: string, source: string): Promise<string>;
  call<T>(name: string, arguments_: Record<string, unknown>): Promise<T>;
  expectError(name: string, arguments_: Record<string, unknown>, code: string): Promise<void>;
}

// Separate server/workspace per scenario: one protocol failure cannot mask the others.
function scenario(name: string, run: (harness: Harness) => Promise<void>): void {
  test(name, { timeout: 120_000 }, async (context) => {
    const executable = process.env.AGDA_TEST_EXECUTABLE;
    if (executable === undefined) {
      context.skip("Set AGDA_TEST_EXECUTABLE and AGDA_TEST_VERSION for targeted live compatibility tests");
      return;
    }
    assert.ok(path.isAbsolute(executable));
    const version = process.env.AGDA_TEST_VERSION;
    assert.ok(version === "2.8.0" || version === "2.9.0");
    const directory = await mkdtemp(path.join(tmpdir(), "agda-targeted-"));
    const client = new Client({ name: "targeted-compatibility", version: "1" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.resolve(".test-dist/src/index.js")], cwd: process.cwd(), stderr: "pipe",
      env: { ...getDefaultEnvironment(), AGDA_MCP_OPTIONS: JSON.stringify({
        agdaExecutable: executable, workspaceRoots: [directory], asyncMode: "never",
        commandTimeoutMs: 90_000,
      }) },
    });
    const harness: Harness = {
      version,
      async file(name, source) {
        const filename = path.join(directory, name);
        await writeFile(filename, source);
        return filename;
      },
      async call<T>(name: string, arguments_: Record<string, unknown>): Promise<T> {
        const result = await client.callTool({ name, arguments: arguments_ });
        assert.equal(result.isError, undefined, `${name}: ${JSON.stringify(result)}`);
        const body = result.structuredContent as { data: T };
        assert.ok(body.data, `${name}: ${JSON.stringify(result)}`);
        return body.data;
      },
      async expectError(name, arguments_, code) {
        const result = await client.callTool({ name, arguments: arguments_ });
        assert.equal(result.isError, true, JSON.stringify(result));
        assert.equal((result.structuredContent as { code: string }).code, code);
      },
    };
    try {
      await client.connect(transport);
      const info = await harness.call<{ agda: { version: string } }>("agda_server_info", {});
      assert.match(info.agda.version, new RegExp(`^${version.replaceAll(".", "\\.")}(?:-[0-9a-f]{7,40})?$`));
      await run(harness);
    } finally {
      await client.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

const identity = "id : {A : Set} → A → A\nid x = ?\n";
const rewrites = ["as_is", "simplified", "instantiated", "normalised", "head_normal"];

scenario("live compatibility: goals, metas, compound and individual contexts", async ({ file, call }) => {
  const modulePath = await file("Inspect.agda", `module Inspect where\n${identity}`);
  const loaded = await call<ModuleCheckResult>("agda_load_module", { modulePath, includeContexts: true });
  assert.equal(loaded.checked, true);
  assert.equal(loaded.goals.length, 1);
  assert.equal(loaded.contexts?.succeeded, 1);
  const goal = loaded.goals[0]!.handle;
  const goals = await call<GoalsResult>("agda_retrieve_goals", { workspace: loaded.workspace });
  assert.equal(goals.goals[0]?.handle, goal);
  const metas = await call<MetavariablesResult>("agda_query_metavariables", { workspace: loaded.workspace });
  assert.equal(metas.metavariables.some(meta => meta.handle === goal && meta.visibility === "visible"), true);
  for (const rewrite of rewrites) {
    const inspected = await call<ContextResult>("agda_retrieve_context", { goal, rewrite });
    assert.equal(inspected.goalType, "A");
    assert.equal(inspected.context.some(entry => entry.reifiedName === "x" && entry.type === "A"), true);
  }
  const batch = await call<ContextsResult>("agda_retrieve_contexts", { goals: [goal] });
  assert.equal(batch.succeeded, 1);
  assert.equal(batch.failed, 0);
});

scenario("live compatibility: local and top-level inference and normalization modes", async ({ file, call }) => {
  const modulePath = await file("Expressions.agda", `module Expressions where\nopen import Agda.Builtin.String using (String)\ndata Bool : Set where\n  true false : Bool\nconstant : Bool → Bool\nconstant _ = true\nshow : {A : Set} → A → String\nshow _ = "shown"\n${identity}`);
  const loaded = await call<ModuleCheckResult>("agda_load_module", { modulePath });
  const goal = loaded.goals[0]!.handle;
  for (const rewrite of rewrites) {
    const local = await call<InferredTypeResult>("agda_infer_type", { goal, expression: "x", rewrite });
    assert.equal(local.type, "A");
    const top = await call<InferredTypeResult>("agda_infer_type", { workspace: loaded.workspace, expression: "true", rewrite });
    assert.equal(top.type, "Bool");
  }
  for (const mode of ["default", "ignore_abstract", "head", "use_show_instance"]) {
    const local = await call<NormalizedExpressionResult>("agda_normalize_expression", { goal, expression: "x", mode });
    assert.equal(local.normalized, mode === "use_show_instance" ? "shown" : "x");
    const top = await call<NormalizedExpressionResult>("agda_normalize_expression", { workspace: loaded.workspace, expression: "constant false", mode });
    assert.equal(top.normalized, mode === "use_show_instance" ? '"shown"' : "true");
  }
});

scenario("live compatibility: show rendering preserves quotes, escapes and Unicode", async ({ file, call }) => {
  for (const text of ["shown", 'line\n"quoted"\\λ']) {
    const modulePath = await file("ShowText.agda", `module ShowText where\nopen import Agda.Builtin.String using (String)\nshow : {A : Set} → A → String\nshow _ = ${JSON.stringify(text)}\n${identity}`);
    const loaded = await call<ModuleCheckResult>("agda_load_module", { modulePath });
    assert.equal(loaded.checked, true);
    const shown = await call<NormalizedExpressionResult>("agda_normalize_expression", {
      workspace: loaded.workspace, expression: '"input"', mode: "use_show_instance",
    });
    const literal = await call<NormalizedExpressionResult>("agda_normalize_expression", {
      workspace: loaded.workspace, expression: 'show "input"', mode: "default",
    });
    assert.equal(shown.expression, '"input"');
    assert.equal(shown.normalized, literal.normalized);
    assert.ok(shown.normalized.startsWith('"') && shown.normalized.endsWith('"'));
    const local = await call<NormalizedExpressionResult>("agda_normalize_expression", {
      goal: loaded.goals[0]!.handle, expression: "x", mode: "use_show_instance",
    });
    assert.equal(local.normalized, text);
  }
});

scenario("live compatibility: refine preview, stale-handle rejection and guarded application", async ({ file, call, expectError }) => {
  const original = `module Refine where\n${identity}`;
  const modulePath = await file("Refine.agda", original);
  const loaded = await call<ModuleCheckResult>("agda_load_module", { modulePath });
  const goal = loaded.goals[0]!.handle;
  const preview = await call<EditPreviewResult>("agda_refine", { goal, expression: "x", apply: false });
  assert.equal(preview.applied, false);
  assert.equal(preview.edits.length, 1);
  assert.equal(await readFile(modulePath, "utf8"), original);
  await expectError("agda_refine", { goal, expression: "x", apply: true }, "STALE_GOAL_HANDLE");
  const applied = await call<EditPreviewResult>("agda_refine", { goal: preview.goals[0]!.handle, expression: "x", apply: true });
  assert.equal(applied.applied, true);
  assert.equal(applied.checked, true);
  assert.deepEqual(applied.goals, []);
  assert.match(await readFile(modulePath, "utf8"), /id x = x/);
});

scenario("live compatibility: case split and successive guarded refinements", async ({ file, call }) => {
  const modulePath = await file("Split.agda", "module Split where\ndata Bool : Set where\n  true false : Bool\nchoose : Bool → Bool\nchoose x = ?\n");
  const loaded = await call<ModuleCheckResult>("agda_load_module", { modulePath });
  let edited = await call<EditPreviewResult>("agda_case_split", { goal: loaded.goals[0]!.handle, variables: "x", apply: true });
  assert.equal(edited.applied, true);
  assert.equal(edited.checked, true);
  assert.equal(edited.goals.length, 2);
  assert.match(await readFile(modulePath, "utf8"), /choose true =/);
  assert.match(await readFile(modulePath, "utf8"), /choose false =/);
  for (let remaining = 2; remaining > 0; remaining--) {
    edited = await call<EditPreviewResult>("agda_refine", { goal: edited.goals[0]!.handle, expression: "true", apply: true });
    assert.equal(edited.checked, true);
    assert.equal(edited.goals.length, remaining - 1);
  }
});

scenario("live compatibility: auto preview and application in all three source formats", async ({ file, call }) => {
  for (const [name, source] of [
    ["Plain.agda", `module Plain where\n${identity}`],
    ["Tex.lagda", `Proof prose.\n\\begin{code}\nmodule Tex where\n${identity}\\end{code}\n`],
    ["Markdown.lagda.md", `Proof prose.\n\n\x60\x60\x60agda\nmodule Markdown where\n${identity}\x60\x60\x60\n`],
  ] as const) {
    const modulePath = await file(name, source);
    const loaded = await call<ModuleCheckResult>("agda_load_module", { modulePath });
    assert.equal(loaded.checked, true, name);
    const preview = await call<AutoResult>("agda_auto", { goal: loaded.goals[0]!.handle, apply: false });
    assert.equal(preview.found, true, name);
    assert.equal(preview.applied, false, name);
    assert.equal(await readFile(modulePath, "utf8"), source, name);
    const applied = await call<AutoResult>("agda_auto", { goal: preview.goals[0]!.handle, apply: true });
    assert.equal(applied.found, true, name);
    assert.equal(applied.applied, true, name);
    assert.equal(applied.checked, true, name);
    assert.deepEqual(applied.goals, [], name);
  }
});

scenario("live compatibility: semantic errors, typecheck diagnostics and recovery", async ({ file, call, expectError }) => {
  const modulePath = await file("Recovery.agda", `module Recovery where\n${identity}`);
  const loaded = await call<ModuleCheckResult>("agda_load_module", { modulePath });
  await expectError("agda_infer_type", { workspace: loaded.workspace, expression: "notInScope" }, "AGDA_COMMAND_REJECTED");
  // UseShowInstance invokes an in-scope show function; its absence is a semantic
  // error on both versions, not a command-encoding incompatibility.
  await expectError("agda_normalize_expression", { goal: loaded.goals[0]!.handle, expression: "x", mode: "use_show_instance" }, "AGDA_COMMAND_REJECTED");
  const inferred = await call<InferredTypeResult>("agda_infer_type", { goal: loaded.goals[0]!.handle, expression: "x" });
  assert.equal(inferred.type, "A");
  const badPath = await file("Bad.agda", "module Bad where\nbad : Set\nbad = Set\n");
  const bad = await call<ModuleCheckResult>("agda_load_module", { modulePath: badPath });
  assert.equal(bad.checked, false);
  assert.ok(bad.diagnostics.length > 0);
  const recovered = await call<ModuleCheckResult>("agda_load_module", { modulePath });
  assert.equal(recovered.checked, true);
  assert.equal(recovered.goals.length, 1);
  const checked = await call<ModuleCheckResult>("agda_typecheck", { workspace: recovered.workspace });
  assert.equal(checked.checked, true);
});
