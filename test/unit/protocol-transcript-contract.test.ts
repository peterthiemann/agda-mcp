import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { InteractionJsonStreamParser } from "../../src/protocol/streamParser.js";

interface ResponseFixture {
  readonly events: readonly unknown[];
  readonly stdout?: readonly string[];
}

const REQUIRED_COMMANDS = [
  "load",
  "metas",
  "goalTypeContext",
  "constraints",
  "makeCase",
  "refineOrIntro",
  "autoOne",
  "compute",
  "computeTopLevel",
  "infer",
  "inferTopLevel",
  "abort",
] as const;

test("all recorded Agda 2.8.0 response fixtures replay independently", async () => {
  const fixtures = JSON.parse(
    await readFile("test/fixtures/agda-2.8.0/protocol/responses.json", "utf8"),
  ) as Record<string, ResponseFixture>;

  for (const name of REQUIRED_COMMANDS) assert.notEqual(fixtures[name], undefined, name);
  for (const [name, fixture] of Object.entries(fixtures)) {
    const transcript = [
      ...(fixture.stdout ?? []),
      ...fixture.events.map((event) => `${JSON.stringify(event)}\n`),
      "JSON> ",
    ].join("");
    const parser = new InteractionJsonStreamParser();
    const tokens = [...parser.feed(Buffer.from(transcript)), ...parser.end()];
    assert.deepEqual(
      tokens.filter((token) => token.kind === "event").map((token) => token.value),
      fixture.events,
      `${name} events`,
    );
    assert.deepEqual(
      tokens.filter((token) => token.kind === "stdout").map((token) => token.text),
      fixture.stdout ?? [],
      `${name} stdout`,
    );
    assert.equal(tokens.filter((token) => token.kind === "prompt").length, 1, `${name} prompt`);
  }
});
