import assert from "node:assert/strict";
import test from "node:test";

import fc from "fast-check";

import { ApplicationError } from "../../src/application/errors.js";
import { validateExpressionSelector } from "../../src/application/service.js";
import {
  normalizeExpressionResponse,
  normalizeInferredTypeResponse,
} from "../../src/normalization/responses.js";
import { FUZZ_SEED, PROPERTY_RUNS } from "./config.js";

test("property: expression selectors accept exactly one non-empty handle", () => {
  fc.assert(
    fc.property(
      fc.boolean(),
      fc.boolean(),
      fc.string({ unit: "binary", minLength: 1, maxLength: 32 }),
      (hasWorkspace, hasGoal, suffix) => {
        const request = {
          expression: "value",
          ...(hasWorkspace ? { workspace: `workspace_${suffix}` } : {}),
          ...(hasGoal ? { goal: `goal_${suffix}` } : {}),
        };
        if (hasWorkspace !== hasGoal) {
          assert.equal(
            validateExpressionSelector(request).kind,
            hasWorkspace ? "workspace" : "goal",
          );
        } else {
          assert.throws(
            () => validateExpressionSelector(request),
            (error: unknown) =>
              error instanceof ApplicationError && error.code === "INVALID_ARGUMENT",
          );
        }
      },
    ),
    { numRuns: PROPERTY_RUNS, seed: FUZZ_SEED ^ 0x50400001 },
  );
});

test("property: unknown native fields do not affect compute and infer projections", () => {
  fc.assert(
    fc.property(
      fc.string({ unit: "binary", maxLength: 128 }),
      fc.dictionary(fc.string({ unit: "binary", maxLength: 12 }), fc.jsonValue(), {
        maxKeys: 8,
      }),
      (rendered, unknownFields) => {
        const normalEvent = {
          ...unknownFields,
          kind: "DisplayInfo",
          info: { ...unknownFields, kind: "NormalForm", expr: rendered },
        };
        const inferEvent = {
          ...unknownFields,
          kind: "DisplayInfo",
          info: { ...unknownFields, kind: "InferredType", expr: rendered },
        };
        assert.equal(normalizeExpressionResponse([normalEvent], "input").normalized, rendered);
        assert.equal(normalizeInferredTypeResponse([inferEvent], "input").type, rendered);
      },
    ),
    { numRuns: PROPERTY_RUNS, seed: FUZZ_SEED ^ 0x50400002 },
  );
});
