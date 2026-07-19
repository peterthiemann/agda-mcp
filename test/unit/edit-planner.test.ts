import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type { SourceFormat } from "../../src/application/domain.js";
import {
  applyTextEdit,
  planAutoEdit,
  planCaseSplitEdit,
  planRefineEdit,
} from "../../src/normalization/editPlanner.js";
import { sourceRangeFromUtf16Offsets } from "../../src/normalization/ranges.js";

const fixtures = JSON.parse(
  await readFile("test/fixtures/agda-2.8.0/protocol/responses.json", "utf8"),
) as Record<string, { events?: readonly unknown[] }>;

function context(source: string, format: SourceFormat = "agda") {
  const start = source.indexOf("{!");
  const end = source.indexOf("!}", start) + 2;
  return {
    modulePath: `/workspace/Example.${format}`,
    sourceFormat: format,
    source,
    sourceFingerprint: "fingerprint",
    goalRange: sourceRangeFromUtf16Offsets(source, start, end),
  } as const;
}

test("GiveAction replaces exactly the goal range", () => {
  const source = "module Tiny where\n\nid x = {! x !}\n";
  const plan = planRefineEdit(fixtures.refineOrIntro?.events ?? [], context(source));
  const edit = plan.edits[0];
  assert.notEqual(edit, undefined);
  assert.equal(applyTextEdit(source, edit as NonNullable<typeof edit>), "module Tiny where\n\nid x = x\n");
  assert.equal(edit?.expectedSourceFingerprint, "fingerprint");
});

test("refine uses the submitted expression when Agda only publishes parenthesis metadata", () => {
  const source = "module Tiny where\nf = {! !}\n";
  const plan = planRefineEdit(
    [{ kind: "GiveAction", giveResult: { paren: true } }],
    context(source),
    "λ x → x",
  );
  assert.equal(plan.edits[0]?.replacement, "(λ x → x)");
});

test("MakeCase replaces the containing clause and preserves indentation", () => {
  const source = "module Tiny where\n\n  f x = {! x !}\nnext = x\n";
  const plan = planCaseSplitEdit(fixtures.makeCase?.events ?? [], context(source));
  const edit = plan.edits[0];
  assert.notEqual(edit, undefined);
  assert.equal(
    applyTextEdit(source, edit as NonNullable<typeof edit>),
    "module Tiny where\n\n  f true = ?\n  f false = ?\nnext = x\n",
  );
});

test("an unambiguous extended-lambda MakeCase response uses the same clause edit", () => {
  const source = "module Tiny where\n\nf = λ where x → {! x !}\n";
  const events = [{
    kind: "MakeCase",
    variant: "ExtendedLambda",
    clauses: ["f = λ where true → false", "             false → true"],
  }];
  const edit = planCaseSplitEdit(events, context(source)).edits[0];
  assert.notEqual(edit, undefined);
  assert.match(applyTextEdit(source, edit as NonNullable<typeof edit>), /λ where true/u);
});

test("failed auto search is a successful empty proposal", () => {
  const source = "module Tiny where\nf = {! !}\n";
  assert.deepEqual(planAutoEdit(fixtures.failedSearch?.events ?? [], context(source)), {
    found: false,
    message: "No solution found",
    edits: [],
  });
});

test("literate edit planning preserves prose and delimiters", () => {
  for (const [format, source] of [
    ["lagda", "before\n\\begin{code}\nf = {! x !}\n\\end{code}\nafter\n"],
    ["lagda.md", "before\n```agda\nf = {! x !}\n```\nafter\n"],
  ] as const) {
    const edit = planRefineEdit(fixtures.refineOrIntro?.events ?? [], context(source, format)).edits[0];
    assert.notEqual(edit, undefined);
    const changed = applyTextEdit(source, edit as NonNullable<typeof edit>);
    assert.equal(changed.startsWith("before\n"), true);
    assert.equal(changed.endsWith("after\n"), true);
    assert.match(changed, /f = x/u);
  }
});
