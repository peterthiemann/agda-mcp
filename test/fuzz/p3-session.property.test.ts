import assert from "node:assert/strict";
import test from "node:test";

import fc from "fast-check";

import { ApplicationError } from "../../src/application/errors.js";
import { normalizeAgdaPosition } from "../../src/normalization/ranges.js";
import { GoalHandleTable } from "../../src/sessions/goalHandles.js";
import { FUZZ_SEED, PROPERTY_RUNS } from "./config.js";

test("property: every code-point offset maps to its exact UTF-16 offset", () => {
  fc.assert(
    fc.property(fc.string({ unit: "binary", maxLength: 512 }), fc.nat(), (source, generated) => {
      const characters = [...source];
      const index = generated % (characters.length + 1);
      const prefix = characters.slice(0, index).join("");
      const lines = prefix.split("\n");
      const line = lines.length;
      const column = [...(lines.at(-1) ?? "")].length + 1;
      const result = normalizeAgdaPosition(source, { pos: index + 1, line, col: column });
      assert.equal(result.utf16Offset, prefix.length);
      assert.equal(source.slice(0, result.utf16Offset), prefix);
    }),
    { numRuns: PROPERTY_RUNS, seed: FUZZ_SEED ^ 0x50300001 },
  );
});

test("property: goal handles validate only against their complete bound state", () => {
  fc.assert(
    fc.property(
      fc.string({ unit: "binary", minLength: 1, maxLength: 32 }),
      fc.string({ unit: "binary", minLength: 1, maxLength: 32 }),
      fc.nat({ max: 10_000 }),
      (workspaceSuffix, moduleSuffix, generation) => {
        const table = new GoalHandleTable();
        const workspace = `workspace_${workspaceSuffix}`;
        const modulePath = `/workspace/${moduleSuffix}.agda`;
        const range = {
          start: { line: 1, column: 1, utf16Offset: 0 },
          end: { line: 1, column: 2, utf16Offset: 1 },
        } as const;
        const protocolRange = {
          file: modulePath,
          start: { offset: 1, line: 1, column: 1 },
          end: { offset: 2, line: 1, column: 2 },
        } as const;
        const handle = table.issue({
          workspace,
          modulePath,
          revision: generation,
          generation,
          sourceFingerprint: "fingerprint",
          interactionPoint: 7,
          range,
          protocolRange,
        });
        const current = {
          workspace,
          modulePath,
          generation,
          sourceFingerprint: "fingerprint",
          interactionPoints: new Set([7]),
        };
        assert.equal(table.validate(handle, current).interactionPoint, 7);
        const stale = (patch: Partial<typeof current>) =>
          assert.throws(
            () => table.validate(handle, { ...current, ...patch }),
            (error: unknown) =>
              error instanceof ApplicationError && error.code === "STALE_GOAL_HANDLE",
          );
        stale({ generation: generation + 1 });
        stale({ workspace: `${workspace}_other` });
        stale({ modulePath: `${modulePath}x` });
        stale({ sourceFingerprint: "other" });
        stale({ interactionPoints: new Set([8]) });
        table.revokeAll();
        assert.throws(() => table.validate(handle, current));
      },
    ),
    { numRuns: PROPERTY_RUNS, seed: FUZZ_SEED ^ 0x50300002 },
  );
});
