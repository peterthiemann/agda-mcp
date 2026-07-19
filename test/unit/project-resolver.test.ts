import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { parseServerOptions } from "../../src/application/config.js";
import { ApplicationError } from "../../src/application/errors.js";
import type { AgdaInstallation } from "../../src/discovery/agdaInstallation.js";
import { discoverModulePlan } from "../../src/discovery/projectResolver.js";

const INSTALLATION: AgdaInstallation = Object.freeze({
  executable: "/usr/bin/agda",
  version: "2.8.0",
  applicationDirectory: "/app",
  dataDirectory: "/data",
  adapter: "agda-2.8.0",
  compatibility: "supported",
  warnings: Object.freeze([]),
});

async function temporaryDirectory(name: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), `agda-mcp-${name}-`));
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof ApplicationError && error.code === code;
}

test("discovery selects the nearest project and builds an immutable load plan", async () => {
  const sandbox = await temporaryDirectory("project");
  const workspace = path.join(sandbox, "workspace");
  const project = path.join(workspace, "packages", "inner");
  const sourceDirectory = path.join(project, "src");
  const externalInclude = path.join(sandbox, "registered-imports");
  const modulePath = path.join(sourceDirectory, "Example.lagda.md");
  try {
    await mkdir(sourceDirectory, { recursive: true });
    await mkdir(externalInclude, { recursive: true });
    await mkdir(path.join(workspace, "global-include"), { recursive: true });
    await mkdir(path.join(workspace, "override-include"), { recursive: true });
    await writeFile(modulePath, "```agda\nmodule Example where\n```\n", "utf8");
    await writeFile(path.join(workspace, "outer.agda-lib"), "name: outer\n", "utf8");
    await writeFile(
      path.join(project, "inner.agda-lib"),
      `name: inner
include: src ${path.relative(project, externalInclude)}
depend: project-lib duplicate
flags: --safe --no-caching
`,
      "utf8",
    );

    const options = parseServerOptions({
      workspaceRoots: [workspace],
      includePaths: ["global-include"],
      libraries: ["global-lib", "duplicate"],
      libraryFile: "global-libraries",
      additionalFlags: ["--caching"],
      workspaceOverrides: [
        {
          root: workspace,
          includePaths: ["override-include"],
          libraries: ["workspace-lib"],
          libraryFile: "workspace-libraries",
          additionalFlags: ["--no-caching"],
        },
      ],
    });
    const plan = await discoverModulePlan(modulePath, options, INSTALLATION);
    const canonicalSandbox = await realpath(sandbox);
    const canonicalWorkspace = path.join(canonicalSandbox, "workspace");
    const canonicalProject = path.join(canonicalWorkspace, "packages", "inner");
    const canonicalSourceDirectory = path.join(canonicalProject, "src");
    const canonicalExternalInclude = path.join(canonicalSandbox, "registered-imports");

    assert.equal(plan.modulePath, path.join(canonicalSourceDirectory, "Example.lagda.md"));
    assert.equal(plan.sourceFormat, "lagda.md");
    assert.equal(plan.workspaceRoot, canonicalWorkspace);
    assert.equal(plan.projectRoot, canonicalProject);
    assert.equal(plan.projectFile?.name, "inner");
    assert.deepEqual(plan.launchArguments, ["--interaction-json"]);
    assert.deepEqual(plan.commandPolicy, {
      commandTimeoutMs: 30_000,
      loadTimeoutMs: 120_000,
      queryTimeoutMs: 30_000,
      transformationTimeoutMs: 60_000,
      maxQueuedCommands: 64,
      rawResponseLimitBytes: 128 * 1024,
      stderrReturnLimitBytes: 32 * 1024,
      maxCommandOutputBytes: 16 * 1024 * 1024,
      abortGraceMs: 1_000,
      handleEntropyBytes: 24,
    });
    assert.deepEqual(plan.load.includePaths, [
      canonicalSourceDirectory,
      canonicalExternalInclude,
      path.join(canonicalProject, "global-include"),
      path.join(canonicalWorkspace, "override-include"),
    ]);
    assert.deepEqual(plan.load.libraries, [
      "project-lib",
      "duplicate",
      "global-lib",
      "workspace-lib",
    ]);
    assert.equal(plan.load.libraryFile, path.join(canonicalWorkspace, "workspace-libraries"));
    assert.deepEqual(plan.load.flags, ["--safe", "--no-caching", "--caching", "--no-caching"]);
    assert.deepEqual(plan.load.arguments, [
      `--include-path=${canonicalSourceDirectory}`,
      `--include-path=${canonicalExternalInclude}`,
      `--include-path=${path.join(canonicalProject, "global-include")}`,
      `--include-path=${path.join(canonicalWorkspace, "override-include")}`,
      "--library=project-lib",
      "--library=duplicate",
      "--library=global-lib",
      "--library=workspace-lib",
      `--library-file=${path.join(canonicalWorkspace, "workspace-libraries")}`,
      "--safe",
      "--no-caching",
      "--caching",
      "--no-caching",
    ]);
    assert.equal(Object.isFrozen(plan), true);
    assert.equal(Object.isFrozen(plan.load.arguments), true);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("discovery falls back to the containing workspace root", async () => {
  const workspace = await temporaryDirectory("fallback");
  const modulePath = path.join(workspace, "Plain.agda");
  try {
    await writeFile(modulePath, "module Plain where\n", "utf8");
    const plan = await discoverModulePlan(
      modulePath,
      parseServerOptions({ workspaceRoots: [workspace] }),
      INSTALLATION,
    );
    assert.equal(plan.projectRoot, await realpath(workspace));
    assert.equal(plan.projectFile, undefined);
    assert.deepEqual(plan.load.arguments, []);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("canonical paths reject direct targets and symlink escapes outside workspace", async () => {
  const sandbox = await temporaryDirectory("escape");
  const workspace = path.join(sandbox, "workspace");
  const outside = path.join(sandbox, "outside");
  const outsideModule = path.join(outside, "Outside.agda");
  const linkedModule = path.join(workspace, "Linked.agda");
  try {
    await mkdir(workspace);
    await mkdir(outside);
    await writeFile(outsideModule, "module Outside where\n", "utf8");
    await symlink(outsideModule, linkedModule);
    const options = parseServerOptions({ workspaceRoots: [workspace] });

    await assert.rejects(discoverModulePlan(outsideModule, options, INSTALLATION), hasCode("PATH_OUTSIDE_WORKSPACE"));
    await assert.rejects(discoverModulePlan(linkedModule, options, INSTALLATION), hasCode("PATH_OUTSIDE_WORKSPACE"));
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("discovery rejects malformed project selection and unauthorized --allow-exec", async () => {
  const workspace = await temporaryDirectory("unsafe");
  const modulePath = path.join(workspace, "Unsafe.agda");
  try {
    await writeFile(modulePath, "module Unsafe where\n", "utf8");
    await writeFile(path.join(workspace, "unsafe.agda-lib"), "flags: --allow-exec\n", "utf8");
    await assert.rejects(
      discoverModulePlan(
        modulePath,
        parseServerOptions({ workspaceRoots: [workspace] }),
        INSTALLATION,
      ),
      hasCode("INVALID_ARGUMENT"),
    );

    await writeFile(path.join(workspace, "second.agda-lib"), "name: second\n", "utf8");
    await assert.rejects(
      discoverModulePlan(
        modulePath,
        parseServerOptions({ workspaceRoots: [workspace], allowAgdaExec: true }),
        INSTALLATION,
      ),
      hasCode("INVALID_ARGUMENT"),
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("workspace overrides must resolve to configured workspace roots", async () => {
  const sandbox = await temporaryDirectory("override-root");
  const workspace = path.join(sandbox, "workspace");
  const unrelated = path.join(sandbox, "unrelated");
  const modulePath = path.join(workspace, "Example.agda");
  try {
    await mkdir(workspace);
    await mkdir(unrelated);
    await writeFile(modulePath, "module Example where\n", "utf8");
    await assert.rejects(
      discoverModulePlan(
        modulePath,
        parseServerOptions({
          workspaceRoots: [workspace],
          workspaceOverrides: [{ root: unrelated, additionalFlags: ["--safe"] }],
        }),
        INSTALLATION,
      ),
      hasCode("INVALID_ARGUMENT"),
    );
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});
