import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { ApplicationError } from "../../src/application/errors.js";
import { parseAgdaLibraryFile } from "../../src/discovery/agdaLib.js";

test(".agda-lib parsing handles inline and continued fields", () => {
  const file = path.resolve("fixture/project.agda-lib");
  const library = parseAgdaLibraryFile(
    `-- project configuration
name: example
depend: standard-library
  agda-categories
include: src generated
flags:
  --safe
  --warning=noUnsupportedIndexedMatch
custom-field: retained
`,
    file,
  );

  assert.equal(library.name, "example");
  assert.deepEqual(library.dependencies, ["standard-library", "agda-categories"]);
  assert.deepEqual(library.includePaths, [
    path.resolve(path.dirname(file), "src"),
    path.resolve(path.dirname(file), "generated"),
  ]);
  assert.deepEqual(library.flags, ["--safe", "--warning=noUnsupportedIndexedMatch"]);
  assert.deepEqual(library.unknownFields, { "custom-field": ["retained"] });
  assert.equal(Object.isFrozen(library), true);
});

test("malformed .agda-lib input is rejected", () => {
  assert.throws(
    () => parseAgdaLibraryFile("  orphan\n", "/project/bad.agda-lib"),
    (error: unknown) => error instanceof ApplicationError && error.code === "INVALID_ARGUMENT",
  );
  assert.throws(
    () => parseAgdaLibraryFile("name: one two\n", "/project/bad.agda-lib"),
    (error: unknown) => error instanceof ApplicationError && error.code === "INVALID_ARGUMENT",
  );
});
