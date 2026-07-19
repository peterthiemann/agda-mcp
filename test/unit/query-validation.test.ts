import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { parseServerOptions } from "../../src/application/config.js";
import type { NormalizationMode, RewriteMode } from "../../src/application/domain.js";
import { ApplicationError } from "../../src/application/errors.js";
import { AgdaApplicationService } from "../../src/application/service.js";
import type { AgdaInstallation } from "../../src/discovery/agdaInstallation.js";

const INSTALLATION: AgdaInstallation = Object.freeze({
  executable: "/usr/bin/agda",
  version: "2.8.0",
  applicationDirectory: "/app",
  dataDirectory: "/data",
  adapter: "agda-2.8.0",
  compatibility: "supported",
  warnings: Object.freeze([]),
});

function invalidArgument(error: unknown): boolean {
  return error instanceof ApplicationError && error.code === "INVALID_ARGUMENT";
}

test("query modes and selectors are rejected before workspace or goal resolution", async () => {
  const service = await AgdaApplicationService.create(
    parseServerOptions({ workspaceRoots: [path.resolve("test/fixtures/agda-2.8.0")] }),
    { installation: INSTALLATION },
  );
  try {
    await assert.rejects(
      service.retrieveContext({ goal: "unknown", rewrite: "invalid" as RewriteMode }),
      invalidArgument,
    );
    await assert.rejects(
      service.normalizeExpression({
        workspace: "unknown",
        expression: "x",
        mode: "invalid" as NormalizationMode,
      }),
      invalidArgument,
    );
    await assert.rejects(
      service.inferType({ workspace: "one", goal: "two", expression: "x" }),
      invalidArgument,
    );
    await assert.rejects(
      service.inferType({ expression: "   ", workspace: "one" }),
      invalidArgument,
    );
  } finally {
    await service.shutdown();
  }
});
