import assert from "node:assert/strict";
import test from "node:test";

import fc, { type JsonValue } from "fast-check";

import { ApplicationError } from "../../src/application/errors.js";
import {
  InteractionJsonStreamParser,
  type InteractionJsonToken,
} from "../../src/protocol/streamParser.js";
import { FUZZ_SEED, PROPERTY_RUNS } from "./config.js";

type JsonObject = { readonly [key: string]: JsonValue | undefined };

const jsonValue = fc.jsonValue({ maxDepth: 5, stringUnit: "binary" });
const eventArbitrary: fc.Arbitrary<JsonObject> = fc
  .tuple(
    fc.record({
      kind: fc.string({ unit: "binary", maxLength: 24 }),
      marker: fc.constant('JSON> { [ ] } " \\ λ 🙂'),
      payload: jsonValue,
    }),
    fc.dictionary(fc.string({ unit: "binary", maxLength: 16 }), jsonValue, { maxKeys: 8 }),
  )
  .map(([required, extra]) => ({ ...extra, ...required }));
const diagnosticLineArbitrary = fc
  .string({ unit: "binary", maxLength: 64 })
  .map(
    (payload) =>
      `diagnostic ${payload.replaceAll("\r", " ").replaceAll("\n", " ")} JSON> {\"not\":\"event\"}\n`,
  );

function chunksAtCuts(buffer: Buffer, generatedCuts: readonly number[]): Buffer[] {
  const cuts = [...new Set(generatedCuts.map((cut) => cut % (buffer.length + 1)))]
    .filter((cut) => cut > 0 && cut < buffer.length)
    .sort((left, right) => left - right);
  const chunks: Buffer[] = [];
  let start = 0;
  for (const cut of cuts) {
    chunks.push(buffer.subarray(start, cut));
    start = cut;
  }
  chunks.push(buffer.subarray(start));
  return chunks;
}

function parse(chunks: readonly Buffer[]): InteractionJsonToken[] {
  const parser = new InteractionJsonStreamParser();
  const tokens: InteractionJsonToken[] = [];
  for (const chunk of chunks) tokens.push(...parser.feed(chunk));
  tokens.push(...parser.end());
  return tokens;
}

function normalized(events: readonly JsonObject[]): unknown[] {
  return events.map((event) => JSON.parse(JSON.stringify(event)) as unknown);
}

test(
  "property: arbitrary JSON events survive arbitrary byte chunking",
  { timeout: 30_000 },
  () => {
    fc.assert(
      fc.property(
        fc.array(eventArbitrary, { maxLength: 16 }),
        fc.array(fc.nat(), { maxLength: 64 }),
        (events, cuts) => {
          const transcript = Buffer.from(
            `${events.map((event) => `${JSON.stringify(event)}\n`).join("")}JSON> `,
          );
          const tokens = parse(chunksAtCuts(transcript, cuts));
          assert.deepEqual(
            tokens.filter((token) => token.kind === "event").map((token) => token.value),
            normalized(events),
          );
          assert.equal(tokens.filter((token) => token.kind === "prompt").length, 1);
          assert.deepEqual(tokens.filter((token) => token.kind === "stdout"), []);
        },
      ),
      { numRuns: PROPERTY_RUNS, seed: FUZZ_SEED },
    );
  },
);

test(
  "property: multiple prompt-delimited responses are invariant under chunking",
  { timeout: 30_000 },
  () => {
    fc.assert(
      fc.property(
        fc.array(fc.array(eventArbitrary, { maxLength: 8 }), { minLength: 1, maxLength: 8 }),
        fc.array(fc.nat(), { maxLength: 64 }),
        (responses, cuts) => {
          const expectedEvents = responses.flatMap((response) => normalized(response));
          const transcript = Buffer.from(
            responses
              .map(
                (response) =>
                  `${response.map((event) => `${JSON.stringify(event)}\n`).join("")}JSON> `,
              )
              .join(""),
          );
          const chunked = parse(chunksAtCuts(transcript, cuts));
          const whole = parse([transcript]);
          assert.deepEqual(chunked, whole);
          assert.deepEqual(
            chunked.filter((token) => token.kind === "event").map((token) => token.value),
            expectedEvents,
          );
          assert.equal(
            chunked.filter((token) => token.kind === "prompt").length,
            responses.length,
          );
        },
      ),
      { numRuns: PROPERTY_RUNS, seed: FUZZ_SEED ^ 0x13579bdf },
    );
  },
);

test(
  "property: diagnostic stdout is lossless and cannot become protocol syntax at chunk boundaries",
  { timeout: 30_000 },
  () => {
    fc.assert(
      fc.property(
        fc.array(diagnosticLineArbitrary, { minLength: 1, maxLength: 16 }),
        fc.array(fc.nat(), { maxLength: 64 }),
        (lines, cuts) => {
          const diagnostics = lines.join("");
          const transcript = Buffer.from(`${diagnostics}JSON> `);
          const tokens = parse(chunksAtCuts(transcript, cuts));
          assert.equal(
            tokens
              .filter((token) => token.kind === "stdout")
              .map((token) => token.text)
              .join(""),
            diagnostics,
          );
          assert.equal(tokens.filter((token) => token.kind === "prompt").length, 1);
          assert.deepEqual(tokens.filter((token) => token.kind === "event"), []);
        },
      ),
      { numRuns: PROPERTY_RUNS, seed: FUZZ_SEED ^ 0x31415926 },
    );
  },
);

test(
  "property: truncating a JSON event always produces a typed protocol failure",
  { timeout: 30_000 },
  () => {
    fc.assert(
      fc.property(eventArbitrary, fc.array(fc.nat(), { maxLength: 32 }), (event, cuts) => {
        const raw = Buffer.from(JSON.stringify(event));
        const truncated = raw.subarray(0, raw.length - 1);
        assert.throws(
          () => parse(chunksAtCuts(truncated, cuts)),
          (error: unknown) =>
            error instanceof ApplicationError && error.code === "UNSUPPORTED_AGDA_PROTOCOL",
        );
      }),
      { numRuns: PROPERTY_RUNS, seed: FUZZ_SEED ^ 0x2468ace },
    );
  },
);
