import assert from "node:assert/strict";
import test from "node:test";

import fc from "fast-check";

import { ApplicationError } from "../../src/application/errors.js";
import { JobRegistry, type JobState } from "../../src/application/jobs.js";
import { FUZZ_SEED, PROPERTY_RUNS } from "./config.js";

/** One step a driver can take against a job. */
type Step =
  | { readonly kind: "succeed" }
  | { readonly kind: "fail" }
  | { readonly kind: "cancel" }
  | { readonly kind: "collect" }
  | { readonly kind: "status" }
  | { readonly kind: "expire" };

const stepArbitrary = fc.oneof(
  fc.constant<Step>({ kind: "succeed" }),
  fc.constant<Step>({ kind: "fail" }),
  fc.constant<Step>({ kind: "cancel" }),
  fc.constant<Step>({ kind: "collect" }),
  fc.constant<Step>({ kind: "status" }),
  fc.constant<Step>({ kind: "expire" }),
);

interface Gate {
  readonly promise: Promise<string>;
  readonly resolve: (value: string) => void;
  readonly reject: (reason: unknown) => void;
}

function gate(): Gate {
  let resolve!: (value: string) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<string>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  // The registry always attaches handlers, but a job that is never driven to
  // completion would otherwise surface as an unhandled rejection.
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * Drives one job through an arbitrary sequence of transitions and asserts the
 * invariants that must hold whatever order they arrive in:
 *
 *  - a job is only ever running, succeeded, failed or cancelled;
 *  - the first terminal transition wins and later ones cannot change it;
 *  - collecting a job releases its capacity, whether it succeeded or threw;
 *  - a collected or expired job is gone, and using its id reports UNKNOWN_JOB;
 *  - the registry never exceeds maxTrackedJobs.
 */
test("property: the job state machine holds under arbitrary transition orders", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(stepArbitrary, { minLength: 1, maxLength: 8 }),
      async (steps) => {
        let now = 1_000;
        const registry = new JobRegistry<string>(
          { asyncMode: "auto", deferAfterMs: 1, maxJobWaitMs: 20, jobRetentionMs: 100, maxTrackedJobs: 4 },
          () => now,
        );
        const pending = gate();
        const outcome = await registry.run("agda_typecheck", () => pending.promise);
        assert.equal(outcome.kind, "deferred");
        const id = outcome.kind === "deferred" ? outcome.job.id : "";

        let terminal: JobState | undefined;
        let collected = false;

        for (const step of steps) {
          if (collected) {
            // Once collected the job must be entirely gone.
            assert.throws(
              () => registry.status(id),
              (error: unknown) =>
                error instanceof ApplicationError && error.code === "UNKNOWN_JOB",
            );
            continue;
          }

          switch (step.kind) {
            case "succeed": {
              pending.resolve("value");
              await settle();
              terminal ??= "succeeded";
              break;
            }
            case "fail": {
              pending.reject(new ApplicationError("COMMAND_TIMEOUT", "slow"));
              await settle();
              terminal ??= "failed";
              break;
            }
            case "cancel": {
              registry.cancel(id);
              pending.reject(new Error("aborted"));
              await settle();
              terminal ??= "cancelled";
              break;
            }
            case "status": {
              const summary = registry.status(id);
              assert.equal(summary.id, id);
              assert.equal(summary.state, terminal ?? "running");
              assert.ok(summary.elapsedMs >= 0);
              break;
            }
            case "expire": {
              now += 1_000;
              registry.prune();
              if (terminal !== undefined) {
                // Only settled jobs age out; a running job must survive.
                assert.equal(registry.size, 0);
                collected = true;
              } else {
                assert.equal(registry.size, 1);
              }
              break;
            }
            case "collect": {
              const before = registry.size;
              assert.equal(before, 1);
              let threw = false;
              try {
                const result = await registry.await(id, 5);
                if (result.kind === "deferred") {
                  // Still running: nothing is released.
                  assert.equal(terminal, undefined);
                  assert.equal(registry.size, 1);
                  break;
                }
                assert.equal(terminal, "succeeded");
              } catch {
                threw = true;
              }
              if (threw) assert.notEqual(terminal, undefined);
              if (terminal !== undefined) {
                // Capacity is released on every terminal outcome, including
                // the ones that surface as a thrown error.
                assert.equal(registry.size, 0, "collecting must release capacity");
                collected = true;
              }
              break;
            }
          }

          assert.ok(registry.size <= 4, "registry must never exceed maxTrackedJobs");
          if (!collected && terminal !== undefined) {
            assert.equal(registry.status(id).state, terminal, "terminal state must be stable");
          }
        }

        // Whatever happened, the registry is internally consistent.
        for (const summary of registry.list()) {
          assert.ok(["running", "succeeded", "failed", "cancelled"].includes(summary.state));
        }
        registry.cancelAll();
        assert.equal(registry.size, 0);
        pending.resolve("drain");
      },
    ),
    { numRuns: PROPERTY_RUNS, seed: FUZZ_SEED ^ 0x50b00001 },
  );
});

test("property: capacity is bounded by maxTrackedJobs across concurrent runs", async () => {
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 1, max: 6 }), fc.integer({ min: 1, max: 10 }), async (cap, attempts) => {
      const registry = new JobRegistry<string>({
        asyncMode: "always",
        maxTrackedJobs: cap,
        jobRetentionMs: 1_000_000,
      });
      const gates: Gate[] = [];
      let admitted = 0;
      let rejected = 0;

      for (let index = 0; index < attempts; index += 1) {
        const g = gate();
        gates.push(g);
        try {
          await registry.run(`tool_${index}`, () => g.promise);
          admitted += 1;
        } catch (error: unknown) {
          assert.ok(error instanceof ApplicationError && error.code === "AGDA_COMMAND_REJECTED");
          rejected += 1;
        }
        // The bound holds after every attempt, not merely at the end.
        assert.ok(registry.size <= cap, `size ${registry.size} exceeded cap ${cap}`);
      }

      assert.equal(admitted + rejected, attempts);
      assert.equal(admitted, Math.min(attempts, cap));
      registry.cancelAll();
      for (const g of gates) g.resolve("drain");
    }),
    { numRuns: PROPERTY_RUNS, seed: FUZZ_SEED ^ 0x50b00002 },
  );
});
