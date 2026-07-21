import assert from "node:assert/strict";
import test from "node:test";

import fc from "fast-check";

import {
  analyzeCodeRegions,
  requireContainingCodeRegion,
} from "../../src/normalization/codeRegions.js";
import type { TextEdit } from "../../src/application/domain.js";
import { ApplicationError } from "../../src/application/errors.js";
import {
  applyTextEdit,
  applyTextEdits,
  planRefineEdit,
} from "../../src/normalization/editPlanner.js";
import { sourceRangeFromUtf16Offsets } from "../../src/normalization/ranges.js";
import { FUZZ_SEED, PROPERTY_RUNS } from "./config.js";

const give = [{ kind: "GiveAction", giveResult: { str: "replacement" } }];

test("property: GiveAction changes only the selected Unicode goal span", () => {
  fc.assert(
    fc.property(fc.string(), fc.string(), (prefix, suffix) => {
      const source = `${prefix}{! hole !}${suffix}`;
      const start = prefix.length;
      const end = start + "{! hole !}".length;
      const plan = planRefineEdit(give, {
        modulePath: "/workspace/P.agda",
        sourceFormat: "agda",
        source,
        sourceFingerprint: "sha",
        goalRange: sourceRangeFromUtf16Offsets(source, start, end),
      });
      assert.equal(applyTextEdit(source, plan.edits[0]!), `${prefix}replacement${suffix}`);
    }),
    { seed: FUZZ_SEED, numRuns: PROPERTY_RUNS },
  );
});

test("property: literate region extraction excludes arbitrary prose and fences", () => {
  fc.assert(
    fc.property(
      fc.string({ unit: fc.constantFrom("a", " ", "λ", "\n") }),
      fc.string({ unit: fc.constantFrom("x", " ", "→", "\n") }),
      (prose, code) => {
        const safeProse = prose.replaceAll("```", "`` ");
        const safeCode = code.replaceAll("```", "`` ");
        const source = `${safeProse}\n\`\`\`agda\n${safeCode}\n\`\`\`\n${safeProse}`;
        const regions = analyzeCodeRegions(source, "lagda.md");
        assert.equal(regions.length, 1);
        const region = regions[0]!;
        assert.equal(source.slice(region.startUtf16Offset, region.endUtf16Offset), `${safeCode}\n`);
        assert.equal(requireContainingCodeRegion(regions, region.startUtf16Offset, region.endUtf16Offset), region);
      },
    ),
    { seed: FUZZ_SEED ^ 0x505, numRuns: PROPERTY_RUNS },
  );
});

test("property: non-overlapping edit sets apply against one snapshot in any order", () => {
  const segment = fc.record({
    before: fc.string({ unit: fc.constantFrom("a", " ", "λ", "\n") }),
    removed: fc.string({
      unit: fc.constantFrom("b", "→", "\n"),
      minLength: 1,
      maxLength: 8,
    }),
    replacement: fc.string({ unit: fc.constantFrom("c", " ", "∀", "\n"), maxLength: 8 }),
  });
  fc.assert(
    fc.property(fc.array(segment, { maxLength: 20 }), (segments) => {
      let source = "";
      let expected = "";
      const offsets: Array<{ start: number; end: number; replacement: string }> = [];
      for (const item of segments) {
        source += item.before;
        expected += item.before;
        const start = source.length;
        source += item.removed;
        expected += item.replacement;
        offsets.push({ start, end: source.length, replacement: item.replacement });
      }
      const edits: TextEdit[] = offsets.map(({ start, end, replacement }) => ({
        file: "/workspace/P.agda",
        range: sourceRangeFromUtf16Offsets(source, start, end),
        replacement,
        expectedSourceFingerprint: "sha",
      }));
      assert.equal(applyTextEdits(source, edits), expected);
      assert.equal(applyTextEdits(source, [...edits].reverse()), expected);
    }),
    { seed: FUZZ_SEED ^ 0x50500002, numRuns: PROPERTY_RUNS },
  );
});

test("property: overlapping or duplicate edit ranges are always rejected", () => {
  fc.assert(
    fc.property(
      fc.string({ unit: fc.constantFrom("a", "λ", "\n"), minLength: 1 }),
      fc.string(),
      (source, replacement) => {
        const range = sourceRangeFromUtf16Offsets(source, 0, source.length);
        const edit: TextEdit = {
          file: "/workspace/P.agda",
          range,
          replacement,
          expectedSourceFingerprint: "sha",
        };
        assert.throws(
          () => applyTextEdits(source, [edit, edit]),
          (error: unknown) =>
            error instanceof ApplicationError && error.code === "UNSUPPORTED_EDIT_SHAPE",
        );
      },
    ),
    { seed: FUZZ_SEED ^ 0x50500003, numRuns: PROPERTY_RUNS },
  );
});
