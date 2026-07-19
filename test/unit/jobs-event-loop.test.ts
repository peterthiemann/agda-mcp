import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Runs a snippet in a fresh Node process with nothing else on the event loop.
 *
 * The job registry's defer window and long-poll are implemented with timers
 * that callers await. If any of them were unref'd, the process would exit with
 * those promises unresolved instead of producing a result — which is exactly
 * how this regressed: it passed on Node 24, where the test runner happened to
 * keep the loop alive, and failed on Node 22 with "Promise resolution is still
 * pending but the event loop has already resolved".
 */
async function runIsolated(snippet: string): Promise<string> {
  const jobsModule = pathToFileURL(
    path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../src/application/jobs.js"),
  ).href;
  const source = `
    const { JobRegistry } = await import(${JSON.stringify(jobsModule)});
    ${snippet}
  `;
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--input-type=module", "-e", source],
    { timeout: 20_000 },
  );
  return stdout.trim();
}

test("the defer window keeps the event loop alive with nothing else pending", async () => {
  const output = await runIsolated(`
    const registry = new JobRegistry({ asyncMode: "auto", deferAfterMs: 50 });
    // Never settles on its own: only the defer timer can end this wait.
    const outcome = await registry.run("agda_load_module", () => new Promise(() => {}));
    console.log(outcome.kind);
  `);
  assert.equal(output, "deferred", "run() must resolve rather than let the process exit");
});

test("a long-poll wait keeps the event loop alive with nothing else pending", async () => {
  const output = await runIsolated(`
    const registry = new JobRegistry({ asyncMode: "auto", deferAfterMs: 10, maxJobWaitMs: 5000 });
    const started = await registry.run("agda_auto", () => new Promise(() => {}));
    const polled = await registry.await(started.job.id, 50);
    console.log(polled.kind);
  `);
  assert.equal(output, "deferred", "await() must resolve rather than let the process exit");
});

test("awaitAny keeps the event loop alive with nothing else pending", async () => {
  const output = await runIsolated(`
    const registry = new JobRegistry({ asyncMode: "auto", deferAfterMs: 10, maxJobWaitMs: 5000 });
    await registry.run("agda_auto", () => new Promise(() => {}));
    const raced = await registry.awaitAny(undefined, 50);
    console.log(raced.kind);
  `);
  assert.equal(output, "pending", "awaitAny() must resolve rather than let the process exit");
});
