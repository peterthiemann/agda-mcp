import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { parseServerOptions } from "../../src/application/config.js";
import { ApplicationError } from "../../src/application/errors.js";
import { discoverAgdaInstallation } from "../../src/discovery/agdaInstallation.js";
import { discoverModulePlan } from "../../src/discovery/projectResolver.js";
import type { AgdaCommand } from "../../src/protocol/adapter.js";
import { agda280Adapter } from "../../src/protocol/adapters/agda-2.8.0.js";
import { AgdaProcessHost } from "../../src/protocol/processHost.js";

test("a live Agda 2.8.0 process loads a module into a complete native transcript", async (context) => {
  const fixtureRoot = path.resolve("test/fixtures/agda-2.8.0");
  const modulePath = path.join(fixtureRoot, "Tiny.agda");
  const options = parseServerOptions({ workspaceRoots: [fixtureRoot] });
  let installation;
  try {
    installation = await discoverAgdaInstallation(options);
  } catch (error: unknown) {
    const code = error instanceof ApplicationError ? error.code : "unknown";
    context.skip(`Agda is unavailable (${code})`);
    return;
  }
  if (installation.version !== "2.8.0") {
    context.skip(`Agda ${installation.version} is installed; live protocol baseline requires 2.8.0`);
    return;
  }

  const plan = await discoverModulePlan(modulePath, options, installation);
  const host = new AgdaProcessHost({
    executable: plan.installation.executable,
    launchArguments: plan.launchArguments,
    cwd: plan.projectRoot,
    adapter: agda280Adapter,
    policy: plan.commandPolicy,
  });
  try {
    await host.start();
    const result = await host.sendCommand(
      { kind: "load", modulePath: plan.modulePath, arguments: plan.load.arguments },
      { currentFile: plan.modulePath },
      { timeoutMs: 120_000 },
    );

    assert.equal(result.raw.adapter, "agda-2.8.0");
    assert.equal(result.raw.complete, true);
    assert.equal(result.raw.stderr.complete, true);
    assert.deepEqual(result.stdoutFragments, []);
    assert.equal(
      result.raw.events.some(
        (event) =>
          typeof event === "object" &&
          event !== null &&
          "kind" in event &&
          event.kind === "InteractionPoints",
      ),
      true,
    );

    const roundTrip = async (command: AgdaCommand): Promise<void> => {
      const commandResult = await host.sendCommand(command, { currentFile: plan.modulePath });
      assert.equal(commandResult.raw.events.length > 0, true, command.kind);
      assert.deepEqual(commandResult.stdoutFragments, [], command.kind);
    };
    await roundTrip({ kind: "metas" });
    await roundTrip({ kind: "goalTypeContext", interactionPoint: 0 });
    await roundTrip({ kind: "constraints" });
    await roundTrip({ kind: "infer", interactionPoint: 0, expression: "x" });
    await roundTrip({ kind: "inferTopLevel", expression: "id" });
    await roundTrip({ kind: "compute", interactionPoint: 0, expression: "x" });
    await roundTrip({ kind: "computeTopLevel", expression: "id" });
    await roundTrip({ kind: "makeCase", interactionPoint: 0, variables: "x" });
    await roundTrip({ kind: "load", modulePath: plan.modulePath, arguments: plan.load.arguments });
    await roundTrip({ kind: "refineOrIntro", interactionPoint: 0, expression: "x" });
    await roundTrip({ kind: "load", modulePath: plan.modulePath, arguments: plan.load.arguments });
    await roundTrip({ kind: "autoOne", interactionPoint: 0 });
  } finally {
    await host.terminate();
  }
});
