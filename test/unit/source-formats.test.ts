import assert from "node:assert/strict";
import test from "node:test";

import { ApplicationError } from "../../src/application/errors.js";
import {
  requireSourceFormat,
  sourceFormatForPath,
} from "../../src/normalization/sourceFormats.js";

test("source formats match the compound literate suffix first", () => {
  assert.equal(sourceFormatForPath("Example.agda"), "agda");
  assert.equal(sourceFormatForPath("Example.lagda"), "lagda");
  assert.equal(sourceFormatForPath("Example.lagda.md"), "lagda.md");
  assert.equal(sourceFormatForPath("Example.LAGDA.MD"), undefined);
  assert.equal(sourceFormatForPath("Example.md"), undefined);
});

test("unsupported direct targets fail with INVALID_ARGUMENT", () => {
  assert.throws(
    () => requireSourceFormat("Example.txt"),
    (error: unknown) => error instanceof ApplicationError && error.code === "INVALID_ARGUMENT",
  );
});
