import { randomBytes } from "node:crypto";

import {
  DEFAULT_ASYNC_MODE,
  DEFAULT_DEFER_AFTER_MS,
  DEFAULT_HANDLE_ENTROPY_BYTES,
  DEFAULT_JOB_RETENTION_MS,
  DEFAULT_MAX_JOB_WAIT_MS,
  DEFAULT_MAX_TRACKED_JOBS,
  type AsyncMode,
} from "./config.js";
import { ApplicationError } from "./errors.js";

export type JobState = "running" | "succeeded" | "failed" | "cancelled";

export interface JobSummary {
  readonly id: string;
  readonly tool: string;
  readonly state: JobState;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly elapsedMs: number;
}

export interface JobPolicy {
  readonly asyncMode: AsyncMode;
  readonly deferAfterMs: number;
  readonly maxJobWaitMs: number;
  readonly jobRetentionMs: number;
  readonly maxTrackedJobs: number;
  readonly handleEntropyBytes: number;
}

export const DEFAULT_JOB_POLICY: JobPolicy = Object.freeze({
  asyncMode: DEFAULT_ASYNC_MODE,
  deferAfterMs: DEFAULT_DEFER_AFTER_MS,
  maxJobWaitMs: DEFAULT_MAX_JOB_WAIT_MS,
  jobRetentionMs: DEFAULT_JOB_RETENTION_MS,
  maxTrackedJobs: DEFAULT_MAX_TRACKED_JOBS,
  handleEntropyBytes: DEFAULT_HANDLE_ENTROPY_BYTES,
});

/** Either the operation finished inside the defer window, or it is still running as a job. */
export type JobOutcome<T> =
  | { readonly kind: "settled"; readonly value: T }
  | { readonly kind: "deferred"; readonly job: JobSummary };

/** Result of racing several jobs; identifies which one finished. */
export type AnyJobOutcome<T> =
  | { readonly kind: "settled"; readonly job: JobSummary; readonly value: T }
  | { readonly kind: "failed"; readonly job: JobSummary; readonly error: unknown }
  | { readonly kind: "pending"; readonly jobs: readonly JobSummary[] };

/** Per-call overrides that shadow the registry policy for one operation. */
export interface RunOverrides {
  readonly asyncMode?: AsyncMode;
  readonly deferAfterMs?: number;
}

interface JobRecord<T> {
  readonly id: string;
  readonly tool: string;
  readonly controller: AbortController;
  readonly startedAtMs: number;
  readonly waiters: Set<(record: JobRecord<T>) => void>;
  state: JobState;
  completedAtMs?: number;
  value?: T;
  error?: unknown;
}

export type Clock = () => number;

/**
 * Tracks Agda operations that outlive a single MCP request.
 *
 * The point is that a tool call never blocks the caller for longer than
 * `deferAfterMs`: slow work keeps running in the background under its own
 * abort controller while the caller gets a job handle back and stays free to
 * do something else.
 */
export class JobRegistry<T = unknown> {
  readonly #jobs = new Map<string, JobRecord<T>>();
  readonly #listeners = new Set<(job: JobSummary) => void>();
  readonly #policy: JobPolicy;
  readonly #now: Clock;

  constructor(policy: Partial<JobPolicy> = {}, now: Clock = () => Date.now()) {
    this.#policy = Object.freeze({ ...DEFAULT_JOB_POLICY, ...policy });
    this.#now = now;
  }

  get policy(): JobPolicy {
    return this.#policy;
  }

  get size(): number {
    return this.#jobs.size;
  }

  /**
   * Start `operation` and race it against the defer window.
   *
   * `requestSignal` only cancels the operation while it is still in that
   * window. Once the job is deferred the request is over, so its signal is
   * detached — otherwise the transport tearing down the request would kill
   * the very work we just promised to keep running.
   */
  async run(
    tool: string,
    operation: (signal: AbortSignal) => Promise<T>,
    requestSignal?: AbortSignal,
    overrides: RunOverrides = {},
  ): Promise<JobOutcome<T>> {
    this.prune();

    const asyncMode = overrides.asyncMode ?? this.#policy.asyncMode;
    // Capped so a per-call override can never reintroduce unbounded blocking.
    const deferAfterMs = Math.min(
      overrides.deferAfterMs ?? this.#policy.deferAfterMs,
      this.#policy.maxJobWaitMs,
    );

    const controller = new AbortController();
    let deferred = false;
    const forwardAbort = (): void => {
      if (!deferred) controller.abort(requestSignal?.reason);
    };
    if (requestSignal !== undefined) {
      if (requestSignal.aborted) controller.abort(requestSignal.reason);
      else requestSignal.addEventListener("abort", forwardAbort, { once: true });
    }
    const detachRequest = (): void => {
      requestSignal?.removeEventListener("abort", forwardAbort);
    };

    const record: JobRecord<T> = {
      id: this.#nextId(),
      tool,
      controller,
      startedAtMs: this.#now(),
      waiters: new Set(),
      state: "running",
    };

    // Registered before the operation starts, so maxTrackedJobs bounds all
    // active work rather than only the part that has already been deferred.
    // Anything that settles inside the defer window is released again below.
    this.#admit(record);

    const work = (async () => operation(controller.signal))().then(
      (value) => {
        this.#settle(record, "succeeded", { value });
      },
      (error: unknown) => {
        this.#settle(record, controller.signal.aborted ? "cancelled" : "failed", { error });
      },
    );

    // Collect inline: the caller receives the outcome directly, so the record
    // must be released whether it succeeded or threw.
    const collectInline = (): JobOutcome<T> => {
      detachRequest();
      this.#jobs.delete(record.id);
      return { kind: "settled", value: this.#unwrap(record) };
    };

    if (asyncMode === "never") {
      await work;
      return collectInline();
    }

    if (asyncMode !== "always") {
      const settledInWindow = await raceWithDelay(work, deferAfterMs);
      if (settledInWindow) return collectInline();
    }

    // Still running: hand back a handle and let it continue unattended.
    deferred = true;
    detachRequest();
    return { kind: "deferred", job: this.#summarize(record) };
  }

  /**
   * Long-poll a job. Resolves as soon as the job settles, or reports it is
   * still running once `waitMs` elapses.
   */
  async await(id: string, waitMs?: number): Promise<JobOutcome<T>> {
    const record = this.#require(id);
    if (record.state === "running") {
      const bounded = Math.min(waitMs ?? this.#policy.maxJobWaitMs, this.#policy.maxJobWaitMs);
      if (bounded > 0) await this.#waitForSettlement(record, bounded);
    }
    if (record.state === "running") return { kind: "deferred", job: this.#summarize(record) };
    // Released before unwrapping, because unwrapping a failed or cancelled job
    // throws — leaving the record behind would hold capacity until expiry.
    this.#jobs.delete(id);
    return { kind: "settled", value: this.#unwrap(record) };
  }

  /**
   * Race several jobs and return the first to settle. Lets a caller that
   * fanned work out across workspaces wait once instead of polling each id.
   */
  async awaitAny(ids?: readonly string[], waitMs?: number): Promise<AnyJobOutcome<T>> {
    this.prune();
    const records =
      ids === undefined || ids.length === 0
        ? [...this.#jobs.values()]
        : ids.map((id) => this.#require(id));
    if (records.length === 0) {
      throw new ApplicationError("UNKNOWN_JOB", "There are no tracked jobs to await");
    }

    let settled = records.find((record) => record.state !== "running");
    if (settled === undefined) {
      const bounded = Math.min(waitMs ?? this.#policy.maxJobWaitMs, this.#policy.maxJobWaitMs);
      if (bounded > 0) settled = await this.#waitForFirst(records, bounded);
    }
    if (settled === undefined) {
      return { kind: "pending", jobs: Object.freeze(records.map((record) => this.#summarize(record))) };
    }

    const job = this.#summarize(settled);
    this.#jobs.delete(settled.id);
    if (settled.state === "succeeded") return { kind: "settled", job, value: settled.value as T };
    const error =
      settled.state === "cancelled"
        ? new ApplicationError("JOB_CANCELLED", `Job ${settled.id} was cancelled`, {
            details: { job: settled.id, tool: settled.tool },
          })
        : settled.error;
    return { kind: "failed", job, error };
  }

  status(id: string): JobSummary {
    return this.#summarize(this.#require(id));
  }

  /** Subscribe to job completions; returns an unsubscribe function. */
  onSettled(listener: (job: JobSummary) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  list(): readonly JobSummary[] {
    this.prune();
    return Object.freeze([...this.#jobs.values()].map((record) => this.#summarize(record)));
  }

  cancel(id: string): JobSummary {
    const record = this.#require(id);
    if (record.state === "running") record.controller.abort(new Error("Job cancelled by client"));
    return this.#summarize(record);
  }

  /** Abort every running job; used when the server shuts down. */
  cancelAll(): void {
    for (const record of this.#jobs.values()) {
      if (record.state === "running") record.controller.abort(new Error("Server shutting down"));
    }
    this.#jobs.clear();
  }

  /** Drop settled jobs that aged out, then enforce the tracked-job ceiling. */
  prune(): void {
    const now = this.#now();
    for (const [id, record] of this.#jobs) {
      if (record.completedAtMs !== undefined && now - record.completedAtMs > this.#policy.jobRetentionMs) {
        this.#jobs.delete(id);
      }
    }
    if (this.#jobs.size <= this.#policy.maxTrackedJobs) return;
    // Oldest-first eviction, preferring already-settled jobs over running work.
    const evictable = [...this.#jobs.values()]
      .filter((record) => record.state !== "running")
      .sort((left, right) => (left.completedAtMs ?? 0) - (right.completedAtMs ?? 0));
    for (const record of evictable) {
      if (this.#jobs.size <= this.#policy.maxTrackedJobs) break;
      this.#jobs.delete(record.id);
    }
  }

  /**
   * Admit a job into the registry, rejecting it if that would exceed capacity.
   * Called before the operation starts so no Agda work is begun that the
   * registry has no room to track.
   */
  #admit(record: JobRecord<T>): void {
    if (this.#jobs.size >= this.#policy.maxTrackedJobs) this.prune();
    if (this.#jobs.size >= this.#policy.maxTrackedJobs) {
      throw new ApplicationError(
        "AGDA_COMMAND_REJECTED",
        "Too many in-flight Agda jobs; await or cancel an existing job first",
        { details: { maxTrackedJobs: this.#policy.maxTrackedJobs } },
      );
    }
    this.#jobs.set(record.id, record);
  }

  #settle(record: JobRecord<T>, state: JobState, outcome: { value?: T; error?: unknown }): void {
    if (record.state !== "running") return;
    record.state = state;
    record.completedAtMs = this.#now();
    if ("value" in outcome) record.value = outcome.value;
    if ("error" in outcome) record.error = outcome.error;
    for (const notify of [...record.waiters]) notify(record);
    record.waiters.clear();
    const summary = this.#summarize(record);
    for (const listener of [...this.#listeners]) {
      try {
        listener(summary);
      } catch {
        // A misbehaving observer must never corrupt job bookkeeping.
      }
    }
  }

  async #waitForFirst(
    records: readonly JobRecord<T>[],
    waitMs: number,
  ): Promise<JobRecord<T> | undefined> {
    return new Promise<JobRecord<T> | undefined>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const notifiers = new Map<JobRecord<T>, (record: JobRecord<T>) => void>();
      const finish = (record: JobRecord<T> | undefined): void => {
        if (timer !== undefined) clearTimeout(timer);
        for (const [target, notify] of notifiers) target.waiters.delete(notify);
        notifiers.clear();
        resolve(record);
      };
      for (const record of records) {
        const notify = (settled: JobRecord<T>): void => finish(settled);
        notifiers.set(record, notify);
        record.waiters.add(notify);
      }
      // Deliberately not unref'd: this timer is awaited. It is cleared by
      // finish(), which every exit path calls.
      timer = setTimeout(() => finish(undefined), waitMs);
    });
  }

  async #waitForSettlement(record: JobRecord<T>, waitMs: number): Promise<void> {
    await new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const notify = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        record.waiters.delete(notify);
        resolve();
      };
      // Deliberately not unref'd: this timer is awaited, so it must keep the
      // event loop alive. It is always cleared, either here or on settlement.
      timer = setTimeout(notify, waitMs);
      record.waiters.add(notify);
    });
  }

  #unwrap(record: JobRecord<T>): T {
    if (record.state === "succeeded") return record.value as T;
    if (record.state === "cancelled") {
      throw new ApplicationError("JOB_CANCELLED", `Job ${record.id} was cancelled`, {
        details: { job: record.id, tool: record.tool },
      });
    }
    throw record.error;
  }

  #require(id: string): JobRecord<T> {
    const record = this.#jobs.get(id);
    if (record === undefined) {
      throw new ApplicationError("UNKNOWN_JOB", `No job with id ${id}`, { details: { job: id } });
    }
    return record;
  }

  #summarize(record: JobRecord<T>): JobSummary {
    const completedAtMs = record.completedAtMs;
    return Object.freeze({
      id: record.id,
      tool: record.tool,
      state: record.state,
      startedAt: new Date(record.startedAtMs).toISOString(),
      elapsedMs: (completedAtMs ?? this.#now()) - record.startedAtMs,
      ...(completedAtMs === undefined ? {} : { completedAt: new Date(completedAtMs).toISOString() }),
    });
  }

  #nextId(): string {
    let id: string;
    do {
      id = `job_${randomBytes(this.#policy.handleEntropyBytes).toString("base64url")}`;
    } while (this.#jobs.has(id));
    return id;
  }
}

/** Resolves true if `work` settled within `delayMs`, false if the window expired first. */
async function raceWithDelay(work: Promise<unknown>, delayMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<false>((resolve) => {
    // Deliberately not unref'd: the caller awaits this race, so an unref'd
    // timer would let the process exit with the defer window unresolved.
    timer = setTimeout(() => resolve(false), delayMs);
  });
  try {
    return await Promise.race([work.then(() => true), expiry]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
