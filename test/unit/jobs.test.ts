import assert from "node:assert/strict";
import test from "node:test";

import { parseServerOptions } from "../../src/application/config.js";
import { ApplicationError } from "../../src/application/errors.js";
import { JobRegistry } from "../../src/application/jobs.js";

function isCode(code: string) {
  return (error: unknown): boolean => error instanceof ApplicationError && error.code === code;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

test("fast operations settle inline and never occupy a job slot", async () => {
  const registry = new JobRegistry<string>({ deferAfterMs: 1_000 });
  const outcome = await registry.run("agda_typecheck", async () => "done");

  assert.equal(outcome.kind, "settled");
  assert.equal(outcome.kind === "settled" ? outcome.value : undefined, "done");
  assert.equal(registry.size, 0);
});

test("slow operations defer instead of blocking the caller", async () => {
  const registry = new JobRegistry<string>({ deferAfterMs: 10 });
  const gate = deferred<string>();

  const outcome = await registry.run("agda_load_module", async () => gate.promise);
  assert.equal(outcome.kind, "deferred");
  assert.equal(outcome.kind === "deferred" ? outcome.job.state : undefined, "running");
  assert.equal(outcome.kind === "deferred" ? outcome.job.tool : undefined, "agda_load_module");
  assert.equal(registry.size, 1);

  const id = outcome.kind === "deferred" ? outcome.job.id : "";
  gate.resolve("late result");

  const collected = await registry.await(id, 1_000);
  assert.equal(collected.kind, "settled");
  assert.equal(collected.kind === "settled" ? collected.value : undefined, "late result");
  // Collected jobs are released so the registry does not grow without bound.
  assert.equal(registry.size, 0);
});

test("awaiting a still-running job reports pending again rather than hanging", async () => {
  const registry = new JobRegistry<string>({ deferAfterMs: 5, maxJobWaitMs: 20 });
  const gate = deferred<string>();
  const outcome = await registry.run("agda_auto", async () => gate.promise);
  const id = outcome.kind === "deferred" ? outcome.job.id : "";

  const pending = await registry.await(id, 10);
  assert.equal(pending.kind, "deferred");

  gate.resolve("eventually");
  assert.equal((await registry.await(id, 1_000)).kind, "settled");
});

test("a deferred job survives the originating request being cancelled", async () => {
  const registry = new JobRegistry<string>({ deferAfterMs: 5 });
  const request = new AbortController();
  const gate = deferred<string>();
  let observedAbort = false;

  const outcome = await registry.run(
    "agda_load_module",
    async (signal) => {
      signal.addEventListener("abort", () => {
        observedAbort = true;
      });
      return gate.promise;
    },
    request.signal,
  );
  const id = outcome.kind === "deferred" ? outcome.job.id : "";

  // The MCP request is over the moment we hand back a job handle.
  request.abort();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(observedAbort, false, "detached request signal must not kill the background job");

  gate.resolve("still delivered");
  assert.equal((await registry.await(id, 1_000)).kind, "settled");
});

test("cancelling a job aborts the operation and reports it as cancelled", async () => {
  const registry = new JobRegistry<string>({ deferAfterMs: 5 });
  const gate = deferred<string>();
  const outcome = await registry.run("agda_auto", async (signal) => {
    signal.addEventListener("abort", () => gate.reject(new Error("aborted")));
    return gate.promise;
  });
  const id = outcome.kind === "deferred" ? outcome.job.id : "";

  assert.equal(registry.cancel(id).state, "running");
  await assert.rejects(() => registry.await(id, 1_000), isCode("JOB_CANCELLED"));
});

test("a failing deferred job surfaces its original error on collection", async () => {
  const registry = new JobRegistry<string>({ deferAfterMs: 5 });
  const gate = deferred<string>();
  const outcome = await registry.run("agda_typecheck", async () => gate.promise);
  const id = outcome.kind === "deferred" ? outcome.job.id : "";

  gate.reject(new ApplicationError("COMMAND_TIMEOUT", "Agda took too long"));
  await assert.rejects(() => registry.await(id, 1_000), isCode("COMMAND_TIMEOUT"));
});

test("unknown job ids are reported rather than silently ignored", async () => {
  const registry = new JobRegistry<string>();
  assert.throws(() => registry.status("job_missing"), isCode("UNKNOWN_JOB"));
  await assert.rejects(() => registry.await("job_missing"), isCode("UNKNOWN_JOB"));
});

test("asyncMode never restores fully synchronous behaviour", async () => {
  const registry = new JobRegistry<string>({ asyncMode: "never", deferAfterMs: 1 });
  const outcome = await registry.run("agda_typecheck", async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
    return "sync";
  });
  assert.equal(outcome.kind, "settled");
  assert.equal(registry.size, 0);
});

test("asyncMode always defers even trivially fast operations", async () => {
  const registry = new JobRegistry<string>({ asyncMode: "always" });
  const outcome = await registry.run("agda_typecheck", async () => "instant");
  assert.equal(outcome.kind, "deferred");

  const id = outcome.kind === "deferred" ? outcome.job.id : "";
  const collected = await registry.await(id, 1_000);
  assert.equal(collected.kind === "settled" ? collected.value : undefined, "instant");
});

test("settled jobs are pruned once they age past the retention window", async () => {
  let now = 1_000;
  const registry = new JobRegistry<string>(
    { deferAfterMs: 5, jobRetentionMs: 100 },
    () => now,
  );
  const gate = deferred<string>();
  await registry.run("agda_typecheck", async () => gate.promise);
  gate.resolve("value");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(registry.size, 1);
  now += 500;
  registry.prune();
  assert.equal(registry.size, 0);
});

test("per-call overrides shadow the registry policy for one call only", async () => {
  const registry = new JobRegistry<string>({ asyncMode: "auto", deferAfterMs: 10_000 });

  // async:true forces a job handle even though the default window is huge.
  const forced = await registry.run("agda_auto", async () => "quick", undefined, {
    asyncMode: "always",
  });
  assert.equal(forced.kind, "deferred");

  // A tight per-call window defers work the default would have awaited.
  const gate = deferred<string>();
  const tight = await registry.run("agda_typecheck", async () => gate.promise, undefined, {
    deferAfterMs: 5,
  });
  assert.equal(tight.kind, "deferred");
  gate.resolve("x");

  // The registry default is untouched by those overrides.
  const normal = await registry.run("agda_typecheck", async () => "inline");
  assert.equal(normal.kind, "settled");
});

test("a per-call defer window cannot exceed maxJobWaitMs", async () => {
  const registry = new JobRegistry<string>({ deferAfterMs: 5, maxJobWaitMs: 50 });
  const gate = deferred<string>();
  const started = Date.now();
  // Asking for a 30s window must still be capped at maxJobWaitMs.
  const outcome = await registry.run("agda_load_module", async () => gate.promise, undefined, {
    deferAfterMs: 30_000,
  });
  assert.equal(outcome.kind, "deferred");
  assert.ok(Date.now() - started < 5_000, "per-call window must be capped, not honoured verbatim");
  gate.resolve("done");
});

test("awaitAny returns the first job to finish and identifies it", async () => {
  const registry = new JobRegistry<string>({ deferAfterMs: 5 });
  const slow = deferred<string>();
  const fast = deferred<string>();
  const first = await registry.run("agda_load_module", async () => slow.promise);
  const second = await registry.run("agda_typecheck", async () => fast.promise);
  const slowId = first.kind === "deferred" ? first.job.id : "";
  const fastId = second.kind === "deferred" ? second.job.id : "";

  fast.resolve("second finished first");
  const outcome = await registry.awaitAny([slowId, fastId], 1_000);

  assert.equal(outcome.kind, "settled");
  assert.equal(outcome.kind === "settled" ? outcome.job.id : "", fastId);
  assert.equal(outcome.kind === "settled" ? outcome.job.tool : "", "agda_typecheck");
  assert.equal(outcome.kind === "settled" ? outcome.value : "", "second finished first");

  slow.resolve("later");
  assert.equal((await registry.await(slowId, 1_000)).kind, "settled");
});

test("awaitAny reports pending when nothing finishes in the window", async () => {
  const registry = new JobRegistry<string>({ deferAfterMs: 5, maxJobWaitMs: 30 });
  const gate = deferred<string>();
  await registry.run("agda_auto", async () => gate.promise);

  const outcome = await registry.awaitAny(undefined, 10);
  assert.equal(outcome.kind, "pending");
  assert.equal(outcome.kind === "pending" ? outcome.jobs.length : 0, 1);
  gate.resolve("eventually");
});

test("awaitAny surfaces a failure with the job that produced it", async () => {
  const registry = new JobRegistry<string>({ deferAfterMs: 5 });
  const gate = deferred<string>();
  const started = await registry.run("agda_typecheck", async () => gate.promise);
  const id = started.kind === "deferred" ? started.job.id : "";

  gate.reject(new ApplicationError("COMMAND_TIMEOUT", "too slow"));
  const outcome = await registry.awaitAny([id], 1_000);

  assert.equal(outcome.kind, "failed");
  assert.equal(outcome.kind === "failed" ? outcome.job.id : "", id);
  assert.ok(isCode("COMMAND_TIMEOUT")(outcome.kind === "failed" ? outcome.error : undefined));
});

test("settle listeners observe completions for out-of-band notification", async () => {
  const registry = new JobRegistry<string>({ deferAfterMs: 5 });
  const seen: string[] = [];
  const unsubscribe = registry.onSettled((job) => seen.push(`${job.tool}:${job.state}`));

  const gate = deferred<string>();
  await registry.run("agda_load_module", async () => gate.promise);
  gate.resolve("value");
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(seen, ["agda_load_module:succeeded"]);

  unsubscribe();
  const second = deferred<string>();
  await registry.run("agda_typecheck", async () => second.promise);
  second.resolve("value");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, ["agda_load_module:succeeded"], "unsubscribe must stop delivery");
});

test("job and limit constants are configurable through server options", () => {
  const options = parseServerOptions({
    asyncMode: "always",
    deferAfterMs: 500,
    maxJobWaitMs: 5_000,
    jobRetentionMs: 60_000,
    maxTrackedJobs: 8,
    abortGraceMs: 250,
    probeTimeoutMs: 7_000,
    probeMaxBufferBytes: 4096,
    handleEntropyBytes: 32,
  });

  assert.equal(options.asyncMode, "always");
  assert.equal(options.deferAfterMs, 500);
  assert.equal(options.maxJobWaitMs, 5_000);
  assert.equal(options.jobRetentionMs, 60_000);
  assert.equal(options.maxTrackedJobs, 8);
  assert.equal(options.abortGraceMs, 250);
  assert.equal(options.probeTimeoutMs, 7_000);
  assert.equal(options.probeMaxBufferBytes, 4096);
  assert.equal(options.handleEntropyBytes, 32);
});

test("invalid job configuration is rejected before Agda starts", () => {
  const isInvalid = isCode("INVALID_ARGUMENT");
  assert.throws(() => parseServerOptions({ asyncMode: "sometimes" }), isInvalid);
  assert.throws(() => parseServerOptions({ deferAfterMs: 0 }), isInvalid);
  assert.throws(() => parseServerOptions({ abortGraceMs: -1 }), isInvalid);
  assert.throws(() => parseServerOptions({ handleEntropyBytes: 4 }), isInvalid);
  assert.throws(
    () => parseServerOptions({ deferAfterMs: 10_000, maxJobWaitMs: 1_000 }),
    isInvalid,
  );
});
