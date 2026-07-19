import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  normalizeConstraintsResponse,
  normalizeContextResponse,
  normalizeExpressionResponse,
  normalizeInferredTypeResponse,
  normalizeLoadResponse,
  normalizeMetasResponse,
} from "../../src/normalization/responses.js";

interface Fixture {
  readonly events: readonly unknown[];
}

test("load responses normalize visible goals and complete-source ranges", async () => {
  const fixtures = JSON.parse(
    await readFile("test/fixtures/agda-2.8.0/protocol/responses.json", "utf8"),
  ) as Record<string, Fixture>;
  const source = await readFile("test/fixtures/agda-2.8.0/Tiny.agda", "utf8");
  const result = normalizeLoadResponse(fixtures.load?.events ?? [], source, "/workspace/Tiny.agda");

  assert.equal(result.checked, true);
  assert.equal(result.goals.length, 1);
  assert.deepEqual(result.goals[0], {
    interactionPoint: 0,
    range: {
      start: { line: 4, column: 8, utf16Offset: 49 },
      end: { line: 4, column: 15, utf16Offset: 56 },
    },
    type: "A",
  });
  assert.deepEqual(result.diagnostics, []);
});

test("Agda type errors are completed unchecked domain results", async () => {
  const fixtures = JSON.parse(
    await readFile("test/fixtures/agda-2.8.0/protocol/responses.json", "utf8"),
  ) as Record<string, Fixture>;
  const result = normalizeLoadResponse(
    fixtures.typeError?.events ?? [],
    "module Error where\n",
    "/workspace/Error.agda",
  );
  assert.equal(result.checked, false);
  assert.equal(result.diagnostics[0]?.severity, "error");
  assert.match(result.diagnostics[0]?.message ?? "", /Set/);
});

test("query responses normalize metas, context, constraints, compute, and infer", async () => {
  const fixtures = JSON.parse(
    await readFile("test/fixtures/agda-2.8.0/protocol/responses.json", "utf8"),
  ) as Record<string, Fixture>;
  const source = await readFile("test/fixtures/agda-2.8.0/Tiny.agda", "utf8");
  const metas = normalizeMetasResponse(
    fixtures.load?.events ?? [],
    source,
    "/workspace/Tiny.agda",
    (id) => (id === 0 ? "goal_handle" : undefined),
  );
  assert.equal(metas.goals[0]?.handle, "goal_handle");
  assert.equal(metas.metavariables[0]?.visibility, "visible");

  const context = normalizeContextResponse(
    fixtures.goalTypeContext?.events ?? [],
    "goal_handle",
  );
  assert.equal(context.goalType, "A");
  assert.deepEqual(context.context, [
    { originalName: "x", reifiedName: "x", type: "A", inScope: true },
  ]);
  assert.deepEqual(normalizeConstraintsResponse(fixtures.constraints?.events ?? [], source), []);
  assert.deepEqual(normalizeExpressionResponse(fixtures.compute?.events ?? [], "x"), {
    expression: "x",
    normalized: "x",
  });
  assert.deepEqual(normalizeInferredTypeResponse(fixtures.infer?.events ?? [], "x"), {
    expression: "x",
    type: "A",
  });
});

test("invisible metas and structured constraints retain their published rendering", () => {
  const source = "module Synthetic where\nvalue = _\n";
  const metas = normalizeMetasResponse(
    [
      {
        kind: "DisplayInfo",
        info: {
          kind: "AllGoalsWarnings",
          errors: [],
          warnings: [],
          visibleGoals: [],
          invisibleGoals: [
            {
              kind: "OfType",
              type: "Set ?ℓ",
              constraintObj: {
                range: [
                  {
                    start: { line: 2, col: 9, pos: 32 },
                    end: { line: 2, col: 10, pos: 33 },
                  },
                ],
              },
            },
          ],
        },
      },
    ],
    source,
    "/workspace/Synthetic.agda",
    () => undefined,
  );
  assert.equal(metas.metavariables[0]?.visibility, "invisible");
  assert.equal(metas.metavariables[0]?.type, "Set ?ℓ");

  const constraints = normalizeConstraintsResponse(
    [
      {
        kind: "DisplayInfo",
        info: {
          kind: "Constraints",
          constraints: [{ kind: "Unblock", message: "_x = value" }],
        },
      },
    ],
    source,
  );
  assert.deepEqual(constraints, [{ kind: "Unblock", rendered: "_x = value" }]);
});
