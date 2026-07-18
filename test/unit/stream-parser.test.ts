import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { ApplicationError } from "../../src/application/errors.js";
import {
  InteractionJsonStreamParser,
  type InteractionJsonToken,
} from "../../src/protocol/streamParser.js";

interface ResponseFixture {
  readonly events: readonly unknown[];
  readonly stdout?: readonly string[];
}

async function fixtures(): Promise<Record<string, ResponseFixture>> {
  return JSON.parse(
    await readFile("test/fixtures/agda-2.8.0/protocol/responses.json", "utf8"),
  ) as Record<string, ResponseFixture>;
}

function parseChunks(chunks: readonly Buffer[]): readonly InteractionJsonToken[] {
  const parser = new InteractionJsonStreamParser();
  const tokens: InteractionJsonToken[] = [];
  for (const chunk of chunks) tokens.push(...parser.feed(chunk));
  tokens.push(...parser.end());
  return tokens;
}

test("the stream parser handles every single split point in a representative transcript", async () => {
  const responseFixtures = await fixtures();
  const events = [
    ...(responseFixtures.load?.events ?? []),
    ...(responseFixtures.unknownEvent?.events ?? []),
  ];
  const transcript = Buffer.from(
    `${JSON.stringify(events[0])}\n${JSON.stringify(events[1])}\nJSON> ${JSON.stringify(events[events.length - 1])}\nJSON> `,
  );

  for (let split = 0; split <= transcript.length; split += 1) {
    const tokens = parseChunks([transcript.subarray(0, split), transcript.subarray(split)]);
    assert.deepEqual(
      tokens.filter((token) => token.kind === "event").map((token) => token.value),
      [events[0], events[1], events[events.length - 1]],
      `split ${split}`,
    );
    assert.equal(tokens.filter((token) => token.kind === "prompt").length, 2, `split ${split}`);
  }
});

test("the stream parser survives byte-at-a-time UTF-8 and prompt boundaries", () => {
  const event = { kind: "Message", value: "λ🙂 JSON> stays data" };
  const transcript = Buffer.from(`${JSON.stringify(event)}\nJSON> `);
  const chunks = [...transcript].map((_, index) => transcript.subarray(index, index + 1));
  const tokens = parseChunks(chunks);
  assert.deepEqual(tokens, [
    { kind: "event", value: event, raw: JSON.stringify(event) },
    { kind: "prompt" },
  ]);
});

test("non-JSON stdout is preserved while protocol whitespace is ignored", async () => {
  const responseFixtures = await fixtures();
  const fragment = responseFixtures.malformedCommand?.stdout?.[0] ?? "";
  const tokens = parseChunks([Buffer.from(`${fragment}JSON> `)]);
  assert.deepEqual(tokens, [{ kind: "stdout", text: fragment }, { kind: "prompt" }]);
});

test("invalid and unterminated JSON fail with a typed protocol error", () => {
  assert.throws(
    () => parseChunks([Buffer.from("{bad}\nJSON> ")]),
    (error: unknown) =>
      error instanceof ApplicationError && error.code === "UNSUPPORTED_AGDA_PROTOCOL",
  );

  const parser = new InteractionJsonStreamParser();
  parser.feed(Buffer.from('{"kind":"Status"'));
  assert.throws(
    () => parser.end(),
    (error: unknown) =>
      error instanceof ApplicationError && error.code === "UNSUPPORTED_AGDA_PROTOCOL",
  );
});
