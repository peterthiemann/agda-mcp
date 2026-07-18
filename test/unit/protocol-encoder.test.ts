import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { ApplicationError } from "../../src/application/errors.js";
import type { AgdaCommand } from "../../src/protocol/adapter.js";
import { agda280Adapter } from "../../src/protocol/adapters/agda-2.8.0.js";
import {
  encodeHaskellString,
  encodeHaskellStringList,
} from "../../src/protocol/stringEncoder.js";

test("Haskell string encoding handles ASCII, controls, separators, and Unicode", () => {
  const cases: readonly [string, string][] = [
    ["", '""'],
    ['quote " and slash / and backslash \\', '"quote \\" and slash / and backslash \\\\"'],
    ["\u0007\b\f\n\r\t\v", '"\\a\\b\\f\\n\\r\\t\\v"'],
    ["\0 followed by 12", '"\\x0\\& followed by 12"'],
    ["λ→🙂", '"\\x3bb\\&\\x2192\\&\\x1f642\\&"'],
  ];
  for (const [input, expected] of cases) assert.equal(encodeHaskellString(input), expected);
  assert.equal(encodeHaskellStringList(["a", "b\nc"]), '["a", "b\\nc"]');
});

test("the Agda 2.8.0 adapter matches recorded command fixtures", async () => {
  const fixture = JSON.parse(
    await readFile("test/fixtures/agda-2.8.0/protocol/commands.json", "utf8"),
  ) as readonly { name: string; command: AgdaCommand; expected: string }[];

  assert.equal(fixture.length, 12);
  for (const entry of fixture) {
    assert.equal(
      agda280Adapter.encodeCommand(entry.command, { currentFile: "/workspace/Tiny.agda" }),
      entry.expected,
      entry.name,
    );
  }
});

test("the adapter rejects invalid goal IDs, ranges, and native event primitives", () => {
  assert.throws(
    () =>
      agda280Adapter.encodeCommand(
        { kind: "makeCase", interactionPoint: -1 },
        { currentFile: "/workspace/Tiny.agda" },
      ),
    (error: unknown) => error instanceof ApplicationError && error.code === "INVALID_ARGUMENT",
  );
  assert.throws(
    () =>
      agda280Adapter.encodeCommand(
        {
          kind: "infer",
          interactionPoint: 0,
          expression: "x",
          range: {
            file: "/workspace/Tiny.agda",
            start: { offset: 10, line: 1, column: 10 },
            end: { offset: 9, line: 1, column: 9 },
          },
        },
        { currentFile: "/workspace/Tiny.agda" },
      ),
    (error: unknown) => error instanceof ApplicationError && error.code === "INVALID_ARGUMENT",
  );
  assert.throws(
    () => agda280Adapter.decodeEvent("not an object"),
    (error: unknown) =>
      error instanceof ApplicationError && error.code === "UNSUPPORTED_AGDA_PROTOCOL",
  );
});
