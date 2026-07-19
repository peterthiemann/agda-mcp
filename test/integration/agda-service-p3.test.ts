import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { parseServerOptions } from "../../src/application/config.js";
import { ApplicationError } from "../../src/application/errors.js";
import { AgdaApplicationService } from "../../src/application/service.js";
import { discoverAgdaInstallation } from "../../src/discovery/agdaInstallation.js";

test("live sessions load complete and incomplete modules in all source formats", async (context) => {
  const fixtureRoot = path.resolve("test/fixtures/agda-2.8.0/formats");
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

  const service = await AgdaApplicationService.create(options, { installation });
  try {
    const fixtures = [
      ["Complete.agda", "agda", false],
      ["Goals.agda", "agda", true],
      ["CompleteTex.lagda", "lagda", false],
      ["GoalsTex.lagda", "lagda", true],
      ["CompleteMarkdown.lagda.md", "lagda.md", false],
      ["GoalsMarkdown.lagda.md", "lagda.md", true],
    ] as const;
    let lastWorkspace: string | undefined;
    for (const [file, format, hasGoal] of fixtures) {
      const loaded = await service.loadModule({ modulePath: path.join(fixtureRoot, file) });
      assert.equal(loaded.data.sourceFormat, format);
      assert.equal(loaded.data.checked, true, file);
      assert.equal(loaded.data.goals.length > 0, hasGoal, file);
      assert.equal(loaded.raw.events.length > 0, true, file);
      if (hasGoal && format !== "agda") {
        assert.equal((loaded.data.goals[0]?.range.start.line ?? 0) > 4, true, file);
      }
      lastWorkspace = loaded.data.workspace;
    }
    assert.notEqual(lastWorkspace, undefined);
    const checked = await service.typecheck({ workspace: lastWorkspace as string });
    assert.equal(checked.data.checked, true);
    assert.equal(checked.data.goals.length, 1);
  } finally {
    await service.shutdown();
  }
});
