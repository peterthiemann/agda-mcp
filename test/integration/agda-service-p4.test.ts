import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { parseServerOptions } from "../../src/application/config.js";
import { ApplicationError } from "../../src/application/errors.js";
import { AgdaApplicationService } from "../../src/application/service.js";
import { discoverAgdaInstallation } from "../../src/discovery/agdaInstallation.js";

async function baseline(context: test.TestContext, workspaceRoot: string) {
  const options = parseServerOptions({ workspaceRoots: [workspaceRoot], commandTimeoutMs: 120_000 });
  try {
    const installation = await discoverAgdaInstallation(options);
    if (installation.version !== "2.8.0") {
      context.skip(`Agda ${installation.version} is installed; live baseline requires 2.8.0`);
      return undefined;
    }
    return { options, installation };
  } catch (error: unknown) {
    const code = error instanceof ApplicationError ? error.code : "unknown";
    context.skip(`Agda is unavailable (${code})`);
    return undefined;
  }
}

test("all read and expression queries use fresh live Agda responses", async (context) => {
  const fixtureRoot = path.resolve("test/fixtures/agda-2.8.0/formats");
  const detected = await baseline(context, fixtureRoot);
  if (detected === undefined) return;
  const service = await AgdaApplicationService.create(detected.options, {
    installation: detected.installation,
  });
  try {
    const loaded = await service.loadModule({ modulePath: path.join(fixtureRoot, "Goals.agda") });
    const workspace = loaded.data.workspace;
    const goal = loaded.data.goals[0]?.handle;
    assert.equal(typeof goal, "string");

    const goals = await service.retrieveGoals({ workspace });
    assert.equal(goals.data.goals[0]?.handle, goal);
    assert.equal(goals.raw.events.length > 0, true);

    const metas = await service.queryMetavariables({ workspace });
    assert.equal(metas.data.metavariables[0]?.handle, goal);
    assert.equal(metas.data.metavariables[0]?.visibility, "visible");

    const constraints = await service.retrieveConstraints({ workspace });
    assert.deepEqual(constraints.data.constraints, []);

    const localContext = await service.retrieveContext({ goal: goal as string });
    assert.equal(localContext.data.context.some((entry) => entry.reifiedName === "x"), true);
    assert.match(localContext.data.goalType, /A/);

    const localNormal = await service.normalizeExpression({
      goal: goal as string,
      expression: "x",
    });
    assert.match(localNormal.data.normalized, /x/);
    const topNormal = await service.normalizeExpression({ workspace, expression: "id" });
    assert.equal(topNormal.data.normalized.length > 0, true);

    const localType = await service.inferType({ goal: goal as string, expression: "x" });
    assert.match(localType.data.type, /A/);
    const topType = await service.inferType({ workspace, expression: "id" });
    assert.match(topType.data.type, /A/);
    await assert.rejects(
      service.inferType({ workspace, expression: "definitelyNotInScope" }),
      (error: unknown) =>
        error instanceof ApplicationError && error.code === "AGDA_COMMAND_REJECTED",
    );
  } finally {
    await service.shutdown();
  }
});

test("stateful queries reject a changed source before reaching Agda", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "agda-mcp-p4-source-"));
  const modulePath = path.join(directory, "Goals.agda");
  await writeFile(modulePath, await readFile("test/fixtures/agda-2.8.0/formats/Goals.agda"));
  const detected = await baseline(context, directory);
  if (detected === undefined) {
    await rm(directory, { recursive: true, force: true });
    return;
  }
  const service = await AgdaApplicationService.create(detected.options, {
    installation: detected.installation,
  });
  try {
    const loaded = await service.loadModule({ modulePath });
    await writeFile(modulePath, `${await readFile(modulePath, "utf8")}\n-- external change\n`);
    await assert.rejects(
      service.retrieveGoals({ workspace: loaded.data.workspace }),
      (error: unknown) => error instanceof ApplicationError && error.code === "SOURCE_CHANGED",
    );
  } finally {
    await service.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});
