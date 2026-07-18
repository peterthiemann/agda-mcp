import assert from "node:assert/strict";
import test from "node:test";

import { parseServerOptions } from "../../src/application/config.js";
import { ApplicationError } from "../../src/application/errors.js";
import {
  discoverAgdaInstallation,
  type AgdaInstallation,
} from "../../src/discovery/agdaInstallation.js";

test("detects the Agda 2.8.0 integration baseline when available", async (context) => {
  let installation: AgdaInstallation;
  try {
    installation = await discoverAgdaInstallation(parseServerOptions());
  } catch (error: unknown) {
    const code = error instanceof ApplicationError ? error.code : "unknown";
    context.skip(`Agda is unavailable (${code})`);
    return;
  }

  if (installation.version !== "2.8.0") {
    context.skip(`Agda ${installation.version} is installed; baseline integration requires 2.8.0`);
    return;
  }

  assert.equal(installation.version, "2.8.0");
  assert.equal(installation.adapter, "agda-2.8.0");
  assert.equal(installation.compatibility, "supported");
  assert.equal(installation.warnings.length, 0);
  assert.match(installation.executable, /agda/u);
  assert.equal(installation.applicationDirectory.startsWith("/"), true);
  assert.equal(installation.dataDirectory.startsWith("/"), true);
});
