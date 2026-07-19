import assert from "node:assert/strict";
import test from "node:test";

import fc from "fast-check";

import {
  analyzeCodeRegions,
  requireContainingCodeRegion,
} from "../../src/normalization/codeRegions.js";
import { applyTextEdit, planRefineEdit } from "../../src/normalization/editPlanner.js";
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
