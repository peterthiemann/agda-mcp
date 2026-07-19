import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { VERSION } from "../../src/version.js";

interface PackageMetadata {
  private?: boolean;
  name?: string;
  version?: string;
  license?: string;
  type?: string;
  engines?: { node?: string };
  bin?: Record<string, string>;
  files?: string[];
}

interface PackageLockMetadata {
  name?: string;
  version?: string;
  packages?: Record<string, { name?: string; version?: string }>;
}

test("package metadata enforces the P0 runtime contract", async () => {
  const contents = await readFile("package.json", "utf8");
  const metadata = JSON.parse(contents) as PackageMetadata;

  assert.equal(metadata.name, "agda-mcp");
  assert.match(metadata.version ?? "", /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u);
  assert.equal(metadata.version, VERSION);
  assert.equal(metadata.private, undefined);
  assert.equal(metadata.license, "MIT");
  assert.equal(metadata.type, "module");
  assert.equal(metadata.engines?.node, ">=22");
  assert.equal(metadata.bin?.["agda-mcp"], "./dist/index.js");
  assert.deepEqual(metadata.files, ["dist", "README.md"]);

  const lock = JSON.parse(await readFile("package-lock.json", "utf8")) as PackageLockMetadata;
  assert.equal(lock.name, metadata.name);
  assert.equal(lock.version, metadata.version);
  assert.equal(lock.packages?.[""]?.name, metadata.name);
  assert.equal(lock.packages?.[""]?.version, metadata.version);
});
