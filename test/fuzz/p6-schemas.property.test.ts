import assert from "node:assert/strict";
import test from "node:test";

import fc from "fast-check";

import {
  autoInputSchema,
  inferTypeInputSchema,
  loadModuleInputSchema,
  normalizeExpressionInputSchema,
  refineInputSchema,
  typecheckInputSchema,
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
  const known = new Set([
    "workspace",
    "goal",
    "expression",
    "usePatternLambda",
    "apply",
    "timeoutMs",
    "deferAfterMs",
    "async",
    "includeRaw",
  ]);
  fc.assert(
    fc.property(
      fc.string({ minLength: 1 }).filter((key) => !known.has(key)),
      fc.jsonValue(),
      (key, value) => {
        assert.equal(workspaceInputSchema.safeParse({ workspace: "w", [key]: value }).success, false);
        assert.equal(refineInputSchema.safeParse({ goal: "g", [key]: value }).success, false);
      },
    ),
    { seed: FUZZ_SEED ^ 0x50600002, numRuns: PROPERTY_RUNS },
  );
});

test("property: apply accepts booleans and rejects every other JSON value", () => {
  fc.assert(
    fc.property(fc.jsonValue(), (apply) => {
      assert.equal(
        refineInputSchema.safeParse({ goal: "g", apply }).success,
        typeof apply === "boolean",
      );
      assert.equal(
        autoInputSchema.safeParse({ goal: "g", apply }).success,
        typeof apply === "boolean",
      );
    }),
    { seed: FUZZ_SEED ^ 0x50600003, numRuns: PROPERTY_RUNS },
  );
});

test("property: module checking rejects contradictory response projections", () => {
  fc.assert(
    fc.property(fc.boolean(), fc.boolean(), (diagnosticsOnly, includeContexts) => {
      const expected = !(diagnosticsOnly && includeContexts);
      assert.equal(
        loadModuleInputSchema.safeParse({
          modulePath: "/workspace/P.agda",
          diagnosticsOnly,
          includeContexts,
        }).success,
        expected,
      );
      assert.equal(
        typecheckInputSchema.safeParse({ workspace: "w", diagnosticsOnly, includeContexts }).success,
        expected,
      );
    }),
    { seed: FUZZ_SEED ^ 0x50600004, numRuns: PROPERTY_RUNS },
  );
});
