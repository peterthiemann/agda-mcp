import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { normalizeLoadResponse } from "../../src/normalization/responses.js";

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
