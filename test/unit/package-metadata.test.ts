import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

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

test("package metadata enforces the P0 runtime contract", async () => {
  const contents = await readFile("package.json", "utf8");
  const metadata = JSON.parse(contents) as PackageMetadata;

  assert.equal(metadata.name, "agda-mcp");
  assert.equal(metadata.version, "0.1.0");
  assert.equal(metadata.private, undefined);
  assert.equal(metadata.license, "MIT");
  assert.equal(metadata.type, "module");
  assert.equal(metadata.engines?.node, ">=22");
  assert.equal(metadata.bin?.["agda-mcp"], "./dist/index.js");
  assert.deepEqual(metadata.files, ["dist", "README.md"]);
});
