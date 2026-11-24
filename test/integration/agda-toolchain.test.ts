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

  if (!/^2\.8\.0(?:-[0-9a-f]{7,40})?$/.test(installation.version)) {
    context.skip(`Agda ${installation.version} is installed; baseline integration requires 2.8.0`);
    return;
  }

  assert.match(installation.version, /^2\.8\.0(?:-[0-9a-f]{7,40})?$/);
  assert.equal(installation.adapter, "agda-2.8.0");
  assert.equal(installation.compatibility, installation.version === "2.8.0" ? "supported" : "unverified");
  assert.equal(installation.warnings.length, installation.version === "2.8.0" ? 0 : 1);
  assert.match(installation.executable, /agda/u);
  assert.equal(installation.applicationDirectory.startsWith("/"), true);
  assert.equal(installation.dataDirectory.startsWith("/"), true);
});
