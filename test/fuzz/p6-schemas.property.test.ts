import assert from "node:assert/strict";
import test from "node:test";

import fc from "fast-check";

import {
  inferTypeInputSchema,
  normalizeExpressionInputSchema,
  refineInputSchema,
  workspaceInputSchema,
} from "../../src/mcp/toolSchemas.js";
import { FUZZ_SEED, PROPERTY_RUNS } from "./config.js";

test("property: scoped expression schemas accept exactly one selector", () => {
  fc.assert(
    fc.property(fc.boolean(), fc.boolean(), fc.string({ minLength: 1 }), (workspace, goal, value) => {
      const input = {
        expression: value,
        ...(workspace ? { workspace: value } : {}),
        ...(goal ? { goal: value } : {}),
      };
      assert.equal(normalizeExpressionInputSchema.safeParse(input).success, workspace !== goal);
      assert.equal(inferTypeInputSchema.safeParse(input).success, workspace !== goal);
    }),
    { seed: FUZZ_SEED ^ 0x50600001, numRuns: PROPERTY_RUNS },
  );
});

test("property: strict schemas reject arbitrary unknown fields", () => {
  fc.assert(
    fc.property(
      fc.string({ minLength: 1 }).filter((key) => !["workspace", "goal", "expression", "usePatternLambda"].includes(key)),
      fc.jsonValue(),
      (key, value) => {
        assert.equal(workspaceInputSchema.safeParse({ workspace: "w", [key]: value }).success, false);
        assert.equal(refineInputSchema.safeParse({ goal: "g", [key]: value }).success, false);
      },
    ),
    { seed: FUZZ_SEED ^ 0x50600002, numRuns: PROPERTY_RUNS },
  );
});
