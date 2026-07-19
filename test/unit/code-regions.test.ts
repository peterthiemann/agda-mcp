import assert from "node:assert/strict";
import test from "node:test";

import { ApplicationError } from "../../src/application/errors.js";
import {
  analyzeCodeRegions,
  requireContainingCodeRegion,
} from "../../src/normalization/codeRegions.js";

test("plain source is one complete code region", () => {
  assert.deepEqual(analyzeCodeRegions("module M where\n", "agda"), [
    { startUtf16Offset: 0, endUtf16Offset: 15 },
  ]);
});

test("literate TeX exposes only begin/end code bodies", () => {
  const source = "prose\n\\begin{code}\nmodule M where\n\\end{code}\nmore\n";
  const regions = analyzeCodeRegions(source, "lagda");
  assert.equal(source.slice(regions[0]?.startUtf16Offset, regions[0]?.endUtf16Offset), "module M where\n");
});

test("literate Markdown accepts backtick and tilde Agda fences", () => {
  const source = "p\n```Agda\nmodule A where\n```\nq\n~~~~ agda title=x\nmodule B where\n~~~~\n";
  const regions = analyzeCodeRegions(source, "lagda.md");
  assert.deepEqual(
    regions.map((region) => source.slice(region.startUtf16Offset, region.endUtf16Offset)),
    ["module A where\n", "module B where\n"],
  );
});

test("malformed or cross-region literate edits are rejected", () => {
  assert.throws(
    () => analyzeCodeRegions("\\begin{code}\nmodule M where\n", "lagda"),
    unsupportedEditShape,
  );
  const source = "```agda\na\n```\nprose\n```agda\nb\n```\n";
  const regions = analyzeCodeRegions(source, "lagda.md");
  assert.throws(
    () => requireContainingCodeRegion(regions, regions[0]?.startUtf16Offset ?? 0, regions[1]?.endUtf16Offset ?? 0),
    unsupportedEditShape,
  );
});

function unsupportedEditShape(error: unknown): boolean {
  return error instanceof ApplicationError && error.code === "UNSUPPORTED_EDIT_SHAPE";
}
