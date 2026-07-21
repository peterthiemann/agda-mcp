import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { parseServerOptions } from "../../src/application/config.js";
import { ApplicationError } from "../../src/application/errors.js";
import { AgdaApplicationService } from "../../src/application/service.js";
import type {
  EditPreviewResult,
  ModuleCheckResult,
  NormalizedResult,
  TextEdit,
} from "../../src/application/domain.js";
import { discoverAgdaInstallation } from "../../src/discovery/agdaInstallation.js";
import { applyTextEdit } from "../../src/normalization/editPlanner.js";

const FIXTURE_ROOT = path.resolve("test/fixtures/agda-2.8.0/formats");

async function liveService(context: test.TestContext, workspaceRoot: string) {
  const options = parseServerOptions({ workspaceRoots: [workspaceRoot], commandTimeoutMs: 120_000 });
  try {
    const installation = await discoverAgdaInstallation(options);
    if (installation.version !== "2.8.0") {
      context.skip(`Agda ${installation.version} is installed; live baseline requires 2.8.0`);
      return undefined;
    }
    return AgdaApplicationService.create(options, { installation });
  } catch (error: unknown) {
    const code = error instanceof ApplicationError ? error.code : "unknown";
    context.skip(`Agda is unavailable (${code})`);
    return undefined;
  }
}

async function copyFixture(directory: string, name: string): Promise<string> {
  const target = path.join(directory, name);
  await writeFile(target, await readFile(path.join(FIXTURE_ROOT, name)));
  return target;
}

async function applyAndTypecheck(
  service: AgdaApplicationService,
  workspace: string,
  modulePath: string,
  edit: TextEdit | undefined,
): Promise<void> {
  assert.notEqual(edit, undefined);
  const source = await readFile(modulePath, "utf8");
  await writeFile(modulePath, applyTextEdit(source, edit as TextEdit));
  const checked = await service.typecheck({ workspace });
  assert.equal(checked.data.checked, true);
  assert.deepEqual(checked.data.diagnostics, []);
}

test("live refine and auto previews are non-mutating and applicable in all source formats", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "agda-mcp-p5-give-"));
  const service = await liveService(context, directory);
  if (service === undefined) {
    await rm(directory, { recursive: true, force: true });
    return;
  }
  try {
    for (const [name, operation] of [
      ["Goals.agda", "refine"],
      ["GoalsTex.lagda", "refine"],
      ["GoalsMarkdown.lagda.md", "refine"],
      ["Goals.agda", "auto"],
      ["GoalsTex.lagda", "auto"],
      ["GoalsMarkdown.lagda.md", "auto"],
    ] as const) {
      const modulePath = await copyFixture(directory, name);
      const before = await readFile(modulePath);
      const loaded = await service.loadModule({ modulePath });
      const goal = loaded.data.goals[0]?.handle;
      assert.notEqual(goal, undefined, name);
      let preview: NormalizedResult<EditPreviewResult>;
      if (operation === "refine") {
        preview = await service.refine({ goal: goal as string, expression: "x" });
      } else {
        preview = await service.auto({ goal: goal as string });
      }
      assert.deepEqual(await readFile(modulePath), before, `${operation} wrote ${name}`);
      assert.equal(preview.data.edits.length, 1, `${operation} did not solve ${name}`);
      assert.equal(preview.data.restoredRevision, loaded.data.revision + 1);
      // The restore reload starts a new generation, so handles rotate.
      assert.notEqual(preview.data.goals[0]?.handle, goal as string);
      assert.notEqual(preview.raw.restore, undefined);
      await applyAndTypecheck(service, loaded.data.workspace, modulePath, preview.data.edits[0]);
    }
  } finally {
    await service.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test("live case split previews preserve all formats and produce typecheckable clauses", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "agda-mcp-p5-case-"));
  const service = await liveService(context, directory);
  if (service === undefined) {
    await rm(directory, { recursive: true, force: true });
    return;
  }
  try {
    for (const name of [
      "CaseSplit.agda",
      "CaseSplitTex.lagda",
      "CaseSplitMarkdown.lagda.md",
    ]) {
      const modulePath = await copyFixture(directory, name);
      const before = await readFile(modulePath);
      const loaded: NormalizedResult<ModuleCheckResult> = await service.loadModule({ modulePath });
      const goal: string | undefined = loaded.data.goals[0]?.handle;
      assert.notEqual(goal, undefined, name);
      const preview = await service.caseSplit({ goal: goal as string, variables: "x" });
      assert.deepEqual(await readFile(modulePath), before, `case split wrote ${name}`);
      assert.equal(preview.data.edits.length, 1);
      assert.match(preview.data.edits[0]?.replacement ?? "", /not true/u);
      assert.match(preview.data.edits[0]?.replacement ?? "", /not false/u);
      // The restore reload starts a new generation, so handles rotate.
      assert.notEqual(preview.data.goals[0]?.handle, goal as string);
      await applyAndTypecheck(service, loaded.data.workspace, modulePath, preview.data.edits[0]);
    }
  } finally {
    await service.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test("live direct transformations apply and typecheck all source formats in one call", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "agda-mcp-p5-direct-"));
  const service = await liveService(context, directory);
  if (service === undefined) {
    await rm(directory, { recursive: true, force: true });
    return;
  }
  try {
    for (const [name, operation] of [
      ["Goals.agda", "refine"],
      ["GoalsTex.lagda", "refine"],
      ["GoalsMarkdown.lagda.md", "refine"],
      ["Goals.agda", "auto"],
      ["GoalsTex.lagda", "auto"],
      ["GoalsMarkdown.lagda.md", "auto"],
      ["CaseSplit.agda", "caseSplit"],
      ["CaseSplitTex.lagda", "caseSplit"],
      ["CaseSplitMarkdown.lagda.md", "caseSplit"],
    ] as const) {
      const modulePath = await copyFixture(directory, name);
      const before = await readFile(modulePath, "utf8");
      const loaded = await service.loadModule({ modulePath });
      const goal = loaded.data.goals[0]?.handle;
      assert.notEqual(goal, undefined, name);
      const transformed: NormalizedResult<EditPreviewResult> = operation === "refine"
        ? await service.refine({ goal: goal as string, expression: "x", apply: true })
        : operation === "auto"
          ? await service.auto({ goal: goal as string, apply: true })
          : await service.caseSplit({ goal: goal as string, variables: "x", apply: true });
      const after = await readFile(modulePath, "utf8");
      assert.notEqual(after, before, `${operation} did not write ${name}`);
      assert.equal(transformed.data.applied, true, name);
      assert.equal(transformed.data.checked, true, name);
      assert.deepEqual(transformed.data.diagnostics, [], name);
      assert.equal(
        transformed.data.sourceFingerprint,
        createHash("sha256").update(after).digest("hex"),
        name,
      );
      assert.notEqual(transformed.raw.typecheck, undefined, name);
      assert.equal(transformed.raw.restore, undefined, name);
    }
  } finally {
    await service.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});
