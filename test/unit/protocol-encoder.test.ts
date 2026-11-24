import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { ApplicationError } from "../../src/application/errors.js";
import type { AgdaCommand } from "../../src/protocol/adapter.js";
import { agda280Adapter } from "../../src/protocol/adapters/agda-2.8.0.js";
import { selectAgdaAdapter } from "../../src/protocol/adapters/select.js";
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

test("constraints encoding selects the exact syntax for each probed Agda version", () => {
  for (const [version, body] of [
    ["2.8.0", "Cmd_constraints"],
    ["2.9.0", "Cmd_constraints AsIs"],
  ] as const) {
    const adapter = selectAgdaAdapter(version);
    assert.equal(adapter.id, `agda-${version}`);
    assert.equal(adapter.encodeCommand({ kind: "constraints" }, {
      currentFile: "/workspace/Tiny.agda",
    }), `IOTCM "/workspace/Tiny.agda" None Direct (${body})\n`);
  }
  assert.equal(selectAgdaAdapter("2.10.0"), agda280Adapter);
  assert.equal(selectAgdaAdapter("2.9.0-abcdef0"), selectAgdaAdapter("2.9.0"));
  assert.equal(selectAgdaAdapter("2.8.0-3d04bac"), agda280Adapter);
  assert.equal(selectAgdaAdapter("2.9.1"), agda280Adapter);
});

test("top-level show preserves 2.8.0 rendering without changing local show or other modes", () => {
  const context = { currentFile: "/workspace/Tiny.agda" };
  assert.equal(selectAgdaAdapter("2.8.0").encodeCommand({
    kind: "computeTopLevel", expression: "x", mode: "use_show_instance",
  }, context), 'IOTCM "/workspace/Tiny.agda" None Direct (Cmd_compute_toplevel UseShowInstance "x")\n');
  assert.equal(selectAgdaAdapter("2.9.0").encodeCommand({
    kind: "computeTopLevel", expression: "x", mode: "use_show_instance",
  }, context), 'IOTCM "/workspace/Tiny.agda" None Direct (Cmd_compute_toplevel DefaultCompute "show (x)")\n');
  for (const command of [
    { kind: "compute", interactionPoint: 0, expression: "x", mode: "use_show_instance" },
    { kind: "computeTopLevel", expression: "x", mode: "default" },
  ] as const) {
    assert.equal(selectAgdaAdapter("2.9.0").encodeCommand(command, context),
      agda280Adapter.encodeCommand(command, context));
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
