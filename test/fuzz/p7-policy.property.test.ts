import assert from "node:assert/strict";
import test from "node:test";

import fc from "fast-check";

import { parseServerOptions } from "../../src/application/config.js";
import { ApplicationError } from "../../src/application/errors.js";
import { SerializedCommandQueue } from "../../src/sessions/commandQueue.js";
import { FUZZ_SEED, PROPERTY_RUNS } from "./config.js";

test("property: positive timeout and queue policies round-trip exactly", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 1_000_000 }),
      fc.integer({ min: 1, max: 1_000 }),
      (timeout, maximum) => {
        const options = parseServerOptions({
          loadTimeoutMs: timeout,
          queryTimeoutMs: timeout,
          transformationTimeoutMs: timeout,
          maxQueuedCommands: maximum,
        });
        assert.equal(options.loadTimeoutMs, timeout);
        assert.equal(options.queryTimeoutMs, timeout);
        assert.equal(options.transformationTimeoutMs, timeout);
        assert.equal(options.maxQueuedCommands, maximum);
      },
    ),
    { seed: FUZZ_SEED ^ 0x50700001, numRuns: PROPERTY_RUNS },
  );
});

test("property: a bounded queue accepts at most its configured pending count", async () => {
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 1, max: 16 }), async (maximum) => {
      const queue = new SerializedCommandQueue(maximum);
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const accepted = [queue.enqueue(async () => blocked)];
      for (let index = 1; index < maximum; index += 1) {
        accepted.push(queue.enqueue(async () => undefined));
      }
      await assert.rejects(
        queue.enqueue(async () => undefined),
        (error: unknown) =>
          error instanceof ApplicationError && error.details.queueFull === true,
      );
      release();
      await Promise.all(accepted);
    }),
    { seed: FUZZ_SEED ^ 0x50700002, numRuns: PROPERTY_RUNS },
  );
});
