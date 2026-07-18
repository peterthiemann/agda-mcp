import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { ApplicationError } from "../../src/application/errors.js";
import {
  InteractionJsonStreamParser,
  type InteractionJsonToken,
} from "../../src/protocol/streamParser.js";
import { FUZZ_RUNS, FUZZ_SEED } from "./config.js";

interface ResponseFixture {
  readonly events: readonly unknown[];
  readonly stdout?: readonly string[];
}

class Random {
  #state: number;

  constructor(seed: number) {
    this.#state = seed === 0 ? 0x9e3779b9 : seed >>> 0;
  }

  next(): number {
    let value = this.#state;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.#state = value >>> 0;
    return this.#state;
  }

  integer(maxExclusive: number): number {
    return maxExclusive <= 1 ? 0 : this.next() % maxExclusive;
  }
}

function splice(
  buffer: Buffer<ArrayBufferLike>,
  start: number,
  deleteCount: number,
  insertion: Buffer<ArrayBufferLike>,
): Buffer<ArrayBufferLike> {
  return Buffer.concat([
    buffer.subarray(0, start),
    insertion,
    buffer.subarray(Math.min(buffer.length, start + deleteCount)),
  ]);
}

function mutate(corpus: Buffer<ArrayBufferLike>, random: Random): Buffer<ArrayBufferLike> {
  let value: Buffer<ArrayBufferLike> = Buffer.from(corpus);
  const mutations = 1 + random.integer(6);
  for (let mutation = 0; mutation < mutations; mutation += 1) {
    const position = random.integer(value.length + 1);
    switch (random.integer(7)) {
      case 0: {
        if (value.length > 0) {
          const index = random.integer(value.length);
          value[index] = (value[index] ?? 0) ^ (1 << random.integer(8));
        }
        break;
      }
      case 1: {
        const count = 1 + random.integer(Math.min(32, Math.max(1, value.length - position)));
        value = splice(value, position, count, Buffer.alloc(0));
        break;
      }
      case 2: {
        const bytes = Buffer.alloc(1 + random.integer(16));
        for (let index = 0; index < bytes.length; index += 1) bytes[index] = random.integer(256);
        value = splice(value, position, 0, bytes);
        break;
      }
      case 3: {
        const start = random.integer(value.length + 1);
        const end = Math.min(value.length, start + 1 + random.integer(32));
        value = splice(value, position, 0, value.subarray(start, end));
        break;
      }
      case 4:
        value = value.subarray(0, position);
        break;
      case 5:
        value = splice(value, position, random.integer(6), Buffer.from("JSON> "));
        break;
      case 6:
        value = splice(value, position, random.integer(6), Buffer.from('{"kind":"Mutated"}'));
        break;
    }
    if (value.length > 64 * 1024) value = value.subarray(0, 64 * 1024);
  }
  return value;
}

function randomChunks(buffer: Buffer<ArrayBufferLike>, random: Random): Buffer<ArrayBufferLike>[] {
  const chunks: Buffer<ArrayBufferLike>[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const size = 1 + random.integer(64);
    chunks.push(buffer.subarray(offset, Math.min(buffer.length, offset + size)));
    offset += size;
  }
  if (chunks.length === 0) chunks.push(Buffer.alloc(0));
  return chunks;
}

function validateTokens(tokens: readonly InteractionJsonToken[]): void {
  for (const token of tokens) {
    if (token.kind === "event") {
      const decoded = JSON.parse(token.raw) as unknown;
      assert.deepEqual(token.value, decoded);
      assert.equal(typeof token.value, "object");
      assert.notEqual(token.value, null);
      assert.equal(Array.isArray(token.value), false);
    } else if (token.kind === "stdout") {
      assert.equal(typeof token.text, "string");
    } else {
      assert.deepEqual(token, { kind: "prompt" });
    }
  }
}

function exercise(input: Buffer<ArrayBufferLike>, seed: number): void {
  const random = new Random(seed ^ 0xa5a5a5a5);
  const parser = new InteractionJsonStreamParser();
  const tokens: InteractionJsonToken[] = [];
  try {
    for (const chunk of randomChunks(input, random)) tokens.push(...parser.feed(chunk));
    tokens.push(...parser.end());
    validateTokens(tokens);
  } catch (error: unknown) {
    if (error instanceof ApplicationError && error.code === "UNSUPPORTED_AGDA_PROTOCOL") return;
    throw new Error(`Unexpected parser failure for fuzz seed ${seed}`, { cause: error });
  }
}

async function corpus(): Promise<Buffer<ArrayBufferLike>[]> {
  const fixtures = JSON.parse(
    await readFile("test/fixtures/agda-2.8.0/protocol/responses.json", "utf8"),
  ) as Record<string, ResponseFixture>;
  const recorded = Object.values(fixtures).map((fixture) =>
    Buffer.from(
      [
        ...(fixture.stdout ?? []),
        ...fixture.events.map((event) => `${JSON.stringify(event)}\n`),
        "JSON> ",
      ].join(""),
    ),
  );
  return [
    ...recorded,
    Buffer.from("JSON> "),
    Buffer.from('{"kind":"Marker","message":"JSON> { [ ] }"}\nJSON> '),
    Buffer.from('{"kind":"Unicode","message":"λ🙂漢字"}\r\nJSON> '),
    Buffer.from('{"kind":"Nested","value":{"array":[[[{"x":true}]]]}}\nJSON> '),
  ];
}

test(
  "mutation fuzz: recorded and edge-case transcripts never crash the parser",
  { timeout: 60_000 },
  async () => {
    const inputs = await corpus();
    for (let iteration = 0; iteration < FUZZ_RUNS; iteration += 1) {
      const seed = (FUZZ_SEED + iteration) >>> 0;
      const random = new Random(seed);
      exercise(mutate(inputs[random.integer(inputs.length)] ?? Buffer.alloc(0), random), seed);
    }
  },
);

test(
  "byte fuzz: arbitrary bounded byte streams only succeed or fail with the protocol error",
  { timeout: 60_000 },
  () => {
    const byteRuns = Math.max(1, Math.floor(FUZZ_RUNS / 4));
    for (let iteration = 0; iteration < byteRuns; iteration += 1) {
      const seed = (FUZZ_SEED ^ 0x5bd1e995 ^ iteration) >>> 0;
      const random = new Random(seed);
      const input = Buffer.alloc(random.integer(2_048));
      for (let index = 0; index < input.length; index += 1) input[index] = random.integer(256);
      exercise(input, seed);
    }
  },
);
