import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import type { AgdaService } from "../application/agdaService.js";
import {
  DEFAULT_INCLUDE_RAW,
  DEFAULT_PROGRESS_INTERVAL_MS,
  parseServerOptions,
  type ServerOptions,
} from "../application/config.js";
import type { NormalizedResult } from "../application/domain.js";
import { ApplicationError, isApplicationError } from "../application/errors.js";
import { JobRegistry, type JobSummary } from "../application/jobs.js";
import { AgdaApplicationService } from "../application/service.js";
import { VERSION } from "../version.js";
import {
  autoInputSchema,
  caseSplitInputSchema,
  contextInputSchema,
  contextsInputSchema,
  inferTypeInputSchema,
  jobAwaitAnyInputSchema,
  jobIdInputSchema,
  jobInputSchema,
  jobListInputSchema,
  loadModuleInputSchema,
  normalizeExpressionInputSchema,
  refineInputSchema,
  serverInfoInputSchema,
  workspaceInputSchema,
} from "./toolSchemas.js";

export type AgdaServiceProvider = () => Promise<AgdaService>;
export type JobRegistryProvider = () => Promise<JobRegistry<NormalizedResult<unknown>>>;

function jsonObject(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function structuredToolResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: jsonObject(value),
  };
}

function successfulToolResult(value: NormalizedResult<unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: jsonObject(value),
  };
}

const RECOVERY_GUIDANCE = Object.freeze({
  INVALID_ARGUMENT: "Correct the tool arguments and retry.",
  PATH_OUTSIDE_WORKSPACE: "Choose a module inside a configured MCP workspace root.",
  AGDA_NOT_FOUND: "Install Agda or configure agdaExecutable, then restart the MCP server.",
  NO_ACTIVE_MODULE: "Call agda_load_module before using this workspace operation.",
  UNKNOWN_WORKSPACE: "Call agda_load_module and use the workspace handle it returns.",
  STALE_GOAL_HANDLE: "Reload or typecheck the module and use a goal handle from the newest result.",
  SOURCE_CHANGED: "Call agda_typecheck or agda_load_module to synchronize with the file on disk.",
  UNSUPPORTED_EDIT_SHAPE: "Inspect raw events and edit this source shape manually.",
  AGDA_COMMAND_REJECTED: "Review the command input and Agda diagnostics, then retry if appropriate.",
  UNSUPPORTED_AGDA_PROTOCOL: "Check agda_server_info; install a supported Agda version or update agda-mcp.",
  COMMAND_TIMEOUT: "Retry after simplifying the request or increasing the configured timeout.",
  PROCESS_EXITED: "Retry by loading the module again; restart the MCP server if the failure persists.",
  OUTPUT_LIMIT_EXCEEDED: "Reduce the query output or increase the configured output limit.",
  RESTORE_FAILED: "Load the module again before using any prior workspace or goal handle.",
  UNKNOWN_JOB: "The job already completed and was collected, or the id is wrong; list jobs with agda_job_list.",
  JOB_CANCELLED: "The job was cancelled; reissue the original tool call if you still need the result.",
} satisfies Record<ApplicationError["code"], string>);

export function applicationErrorPayload(error: unknown) {
  const applicationError = isApplicationError(error)
    ? error
    : new ApplicationError("AGDA_COMMAND_REJECTED", "Unexpected Agda MCP failure", {
        recoverable: false,
      });
  return Object.freeze({
    code: applicationError.code,
    message: applicationError.message,
    recoverable: applicationError.recoverable,
    details: applicationError.details,
    guidance: RECOVERY_GUIDANCE[applicationError.code],
  });
}

function failedToolResult(error: unknown, extra: Record<string, unknown> = {}) {
  const body = { ...applicationErrorPayload(error), ...extra };
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(body) }],
    structuredContent: jsonObject(body),
  };
}

function pendingToolResult(job: JobSummary) {
  const body = {
    status: "pending" as const,
    job,
    guidance:
      `Agda is still working on ${job.tool}. You are not blocked: do other work, then call ` +
      `agda_job_await with job "${job.id}" to collect the result, or agda_job_cancel to abandon it.`,
  };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(body) }],
    structuredContent: jsonObject(body),
  };
}

function settledOrPending(outcome: {
  kind: "settled" | "deferred";
  value?: NormalizedResult<unknown>;
  job?: JobSummary;
}) {
  return outcome.kind === "settled"
    ? successfulToolResult(outcome.value as NormalizedResult<unknown>)
    : pendingToolResult(outcome.job as JobSummary);
}

/** Per-call overrides accepted by every Agda tool. */
export interface CallOptions {
  readonly timeoutMs?: number | undefined;
  readonly deferAfterMs?: number | undefined;
  readonly async?: boolean | undefined;
  readonly includeRaw?: boolean | undefined;
  readonly diagnosticsOnly?: boolean | undefined;
}

interface RawLike {
  readonly events?: readonly unknown[];
  readonly stderr?: { readonly chunks?: readonly string[] };
  readonly restore?: RawLike;
  readonly [key: string]: unknown;
}

/**
 * Replaces the native event log with its own summary. The events are by far the
 * largest part of a response and are rarely useful to a caller, so they are
 * omitted unless explicitly requested. Everything describing the transcript —
 * byte counts, completeness, stderr — is preserved.
 */
function summarizeRaw(raw: RawLike): Record<string, unknown> {
  const { events, restore, ...rest } = raw;
  return {
    ...rest,
    eventsOmitted: true,
    eventCount: events?.length ?? 0,
    ...(restore === undefined ? {} : { restore: summarizeRaw(restore) }),
  };
}

/**
 * Applies the response-shaping options to one result. Runs before the value is
 * stored in the job registry, so a deferred result is shaped the same way the
 * inline one would have been.
 */
function shapeResult(
  result: NormalizedResult<unknown>,
  options: { includeRaw: boolean; diagnosticsOnly: boolean },
): NormalizedResult<unknown> {
  let data = result.data;
  if (options.diagnosticsOnly && data !== null && typeof data === "object" && "diagnostics" in data) {
    const { goals: _goals, invisibleMetavariables: _metas, ...kept } = data as Record<string, unknown>;
    data = kept;
  }
  const raw = options.includeRaw
    ? result.raw
    : (summarizeRaw(result.raw as unknown as RawLike) as unknown as NormalizedResult<unknown>["raw"]);
  return { ...result, data, raw };
}

/** The subset of the SDK's handler context this module relies on. */
interface RequestExtra {
  readonly signal: AbortSignal;
  readonly _meta?: { readonly progressToken?: string | number | undefined } | undefined;
  readonly sendNotification: (notification: {
    method: "notifications/progress";
    params: {
      progressToken: string | number;
      progress: number;
      total?: number | undefined;
      message?: string | undefined;
    };
  }) => Promise<void>;
}

function runOverrides(call: CallOptions) {
  return {
    ...(call.async === undefined ? {} : { asyncMode: call.async ? ("always" as const) : ("never" as const) }),
    ...(call.deferAfterMs === undefined ? {} : { deferAfterMs: call.deferAfterMs }),
  };
}

function operationContext(call: CallOptions, signal: AbortSignal) {
  return { signal, ...(call.timeoutMs === undefined ? {} : { timeoutMs: call.timeoutMs }) };
}

/**
 * Emits `notifications/progress` on a heartbeat while `work` is outstanding,
 * but only when the client supplied a progress token for this request. It is
 * purely advisory: failures to notify never affect the operation.
 */
async function withProgress<T>(
  extra: RequestExtra,
  label: string,
  intervalMs: number,
  work: Promise<T>,
): Promise<T> {
  const progressToken = extra._meta?.progressToken;
  if (progressToken === undefined || intervalMs <= 0) return work;

  const startedAt = Date.now();
  const timer = setInterval(() => {
    const elapsedMs = Date.now() - startedAt;
    void extra
      .sendNotification({
        method: "notifications/progress",
        params: {
          progressToken,
          progress: elapsedMs,
          message: `${label}: ${Math.round(elapsedMs / 1000)}s elapsed`,
        },
      })
      .catch(() => undefined);
  }, intervalMs);
  // Unref'd on purpose, unlike the timers in the job registry: nothing awaits
  // this heartbeat, so it must never keep the process alive on its own.
  timer.unref?.();
  try {
    return await work;
  } finally {
    clearInterval(timer);
  }
}

/**
 * Runs an Agda operation without holding the MCP request open indefinitely.
 *
 * Fast operations return their result inline exactly as before. Anything that
 * outruns the defer window is handed to the job registry and the caller gets a
 * job handle immediately, so the agent stays free to think and act while Agda
 * grinds away.
 */
async function invoke(
  jobsProvider: JobRegistryProvider,
  tool: string,
  call: CallOptions,
  extra: RequestExtra,
  operation: (context: { signal: AbortSignal; timeoutMs?: number }) => Promise<NormalizedResult<unknown>>,
  progressIntervalMs: number,
  includeRawByDefault: boolean,
) {
  try {
    const jobs = await jobsProvider();
    const shaping = {
      includeRaw: call.includeRaw ?? includeRawByDefault,
      diagnosticsOnly: call.diagnosticsOnly ?? false,
    };
    const outcome = await withProgress(
      extra,
      tool,
      progressIntervalMs,
      jobs.run(
        tool,
        async (signal) => shapeResult(await operation(operationContext(call, signal)), shaping),
        extra.signal,
        runOverrides(call),
      ),
    );
    return settledOrPending(outcome);
  } catch (error: unknown) {
    return failedToolResult(error);
  }
}

export function createAgdaMcpServer(
  serviceProvider: AgdaServiceProvider,
  jobRegistryProvider?: JobRegistryProvider,
  progressIntervalMs: number = DEFAULT_PROGRESS_INTERVAL_MS,
  includeRawByDefault: boolean = DEFAULT_INCLUDE_RAW,
): McpServer {
  const server = new McpServer(
    { name: "agda-mcp", version: VERSION },
    { capabilities: { logging: {} } },
  );
  let fallbackRegistry: JobRegistry<NormalizedResult<unknown>> | undefined;
  const baseProvider: JobRegistryProvider =
    jobRegistryProvider ??
    (async () => (fallbackRegistry ??= new JobRegistry<NormalizedResult<unknown>>()));

  // Announce completions over the logging channel, the only spec-correct way to
  // reach a client outside an open request. It does not wake an agent mid-turn,
  // but it surfaces "Agda finished" in clients that display server logs.
  let observed: JobRegistry<NormalizedResult<unknown>> | undefined;
  const jobs: JobRegistryProvider = async () => {
    const registry = await baseProvider();
    if (observed !== registry) {
      observed = registry;
      registry.onSettled((job) => {
        void server.server
          .sendLoggingMessage({
            level: job.state === "succeeded" ? "info" : "warning",
            logger: "agda-mcp.jobs",
            data: `${job.tool} ${job.state} after ${job.elapsedMs}ms (job ${job.id})`,
          })
          .catch(() => undefined);
      });
    }
    return registry;
  };

  server.registerTool(
    "agda_server_info",
    {
      description: "Report the detected Agda installation, compatibility, and active workspaces",
      inputSchema: serverInfoInputSchema,
    },
    async (call, extra) =>
      invoke(
        jobs,
        "agda_server_info",
        call,
        extra,
        async (context) => (await serviceProvider()).serverInfo(context),
        progressIntervalMs,
        includeRawByDefault,
      ),
  );

  server.registerTool(
    "agda_load_module",
    {
      description: "Load and typecheck one top-level Agda module from disk",
      inputSchema: loadModuleInputSchema,
    },
    async ({ modulePath, ...call }, extra) =>
      invoke(
        jobs,
        "agda_load_module",
        call,
        extra,
        async (context) => (await serviceProvider()).loadModule({ modulePath }, context),
        progressIntervalMs,
        includeRawByDefault,
      ),
  );

  server.registerTool(
    "agda_typecheck",
    {
      description: "Reload and typecheck the active module in a workspace",
      inputSchema: workspaceInputSchema,
    },
    async ({ workspace, ...call }, extra) =>
      invoke(
        jobs,
        "agda_typecheck",
        call,
        extra,
        async (context) => (await serviceProvider()).typecheck({ workspace }, context),
        progressIntervalMs,
        includeRawByDefault,
      ),
  );

  server.registerTool(
    "agda_retrieve_goals",
    {
      description: "Retrieve the current visible goals and opaque handles",
      inputSchema: workspaceInputSchema,
    },
    async ({ workspace, ...call }, extra) =>
      invoke(
        jobs,
        "agda_retrieve_goals",
        call,
        extra,
        async (context) => (await serviceProvider()).retrieveGoals({ workspace }, context),
        progressIntervalMs,
        includeRawByDefault,
      ),
  );

  server.registerTool(
    "agda_retrieve_context",
    {
      description: "Retrieve the type and local context for an opaque goal handle",
      inputSchema: contextInputSchema,
    },
    async ({ goal, rewrite, ...call }, extra) =>
      invoke(
        jobs,
        "agda_retrieve_context",
        call,
        extra,
        async (context) =>
          (await serviceProvider()).retrieveContext(
            { goal, ...(rewrite === undefined ? {} : { rewrite }) },
            context,
          ),
        progressIntervalMs,
        includeRawByDefault,
      ),
  );

  server.registerTool(
    "agda_retrieve_contexts",
    {
      description:
        "Retrieve types and local contexts for several goal handles in one round trip",
      inputSchema: contextsInputSchema,
    },
    async ({ goals, rewrite, ...call }, extra) =>
      invoke(
        jobs,
        "agda_retrieve_contexts",
        call,
        extra,
        async (context) =>
          (await serviceProvider()).retrieveContexts(
            { goals, ...(rewrite === undefined ? {} : { rewrite }) },
            context,
          ),
        progressIntervalMs,
        includeRawByDefault,
      ),
  );

  server.registerTool(
    "agda_retrieve_constraints",
    {
      description: "Retrieve constraints for the active module in a workspace",
      inputSchema: workspaceInputSchema,
    },
    async ({ workspace, ...call }, extra) =>
      invoke(
        jobs,
        "agda_retrieve_constraints",
        call,
        extra,
        async (context) => (await serviceProvider()).retrieveConstraints({ workspace }, context),
        progressIntervalMs,
        includeRawByDefault,
      ),
  );

  server.registerTool(
    "agda_case_split",
    {
      description: "Preview a non-mutating case split, then reload canonical Agda state",
      inputSchema: caseSplitInputSchema,
    },
    async ({ goal, variables, ...call }, extra) =>
      invoke(
        jobs,
        "agda_case_split",
        call,
        extra,
        async (context) =>
          (await serviceProvider()).caseSplit(
            { goal, ...(variables === undefined ? {} : { variables }) },
            context,
          ),
        progressIntervalMs,
        includeRawByDefault,
      ),
  );

  server.registerTool(
    "agda_refine",
    {
      description: "Preview a non-mutating refinement, then reload canonical Agda state",
      inputSchema: refineInputSchema,
    },
    async ({ goal, expression, usePatternLambda, ...call }, extra) =>
      invoke(
        jobs,
        "agda_refine",
        call,
        extra,
        async (context) =>
          (await serviceProvider()).refine(
            {
              goal,
              ...(expression === undefined ? {} : { expression }),
              ...(usePatternLambda === undefined ? {} : { usePatternLambda }),
            },
            context,
          ),
        progressIntervalMs,
        includeRawByDefault,
      ),
  );

  server.registerTool(
    "agda_auto",
    {
      description: "Preview non-mutating Agda proof search, then reload canonical state",
      inputSchema: autoInputSchema,
    },
    async ({ goal, query, ...call }, extra) =>
      invoke(
        jobs,
        "agda_auto",
        call,
        extra,
        async (context) =>
          (await serviceProvider()).auto(
            { goal, ...(query === undefined ? {} : { query }) },
            context,
          ),
        progressIntervalMs,
        includeRawByDefault,
      ),
  );

  server.registerTool(
    "agda_normalize_expression",
    {
      description: "Normalize an expression in workspace or goal-local scope",
      inputSchema: normalizeExpressionInputSchema,
    },
    async ({ expression, workspace, goal, mode, ...call }, extra) =>
      invoke(
        jobs,
        "agda_normalize_expression",
        call,
        extra,
        async (context) =>
          (await serviceProvider()).normalizeExpression(
            {
              expression,
              ...(workspace === undefined ? {} : { workspace }),
              ...(goal === undefined ? {} : { goal }),
              ...(mode === undefined ? {} : { mode }),
            },
            context,
          ),
        progressIntervalMs,
        includeRawByDefault,
      ),
  );

  server.registerTool(
    "agda_infer_type",
    {
      description: "Infer the type of an expression in workspace or goal-local scope",
      inputSchema: inferTypeInputSchema,
    },
    async ({ expression, workspace, goal, rewrite, ...call }, extra) =>
      invoke(
        jobs,
        "agda_infer_type",
        call,
        extra,
        async (context) =>
          (await serviceProvider()).inferType(
            {
              expression,
              ...(workspace === undefined ? {} : { workspace }),
              ...(goal === undefined ? {} : { goal }),
              ...(rewrite === undefined ? {} : { rewrite }),
            },
            context,
          ),
        progressIntervalMs,
        includeRawByDefault,
      ),
  );

  server.registerTool(
    "agda_query_metavariables",
    {
      description: "Query visible and interaction-backend invisible metavariables",
      inputSchema: workspaceInputSchema,
    },
    async ({ workspace, ...call }, extra) =>
      invoke(
        jobs,
        "agda_query_metavariables",
        call,
        extra,
        async (context) => (await serviceProvider()).queryMetavariables({ workspace }, context),
        progressIntervalMs,
        includeRawByDefault,
      ),
  );

  server.registerTool(
    "agda_job_await",
    {
      description:
        "Collect the result of a pending Agda job, waiting up to waitMs; returns pending again if still running",
      inputSchema: jobInputSchema,
    },
    async ({ job, waitMs }) => {
      try {
        const registry = await jobs();
        return settledOrPending(await registry.await(job, waitMs));
      } catch (error: unknown) {
        return failedToolResult(error);
      }
    },
  );

  server.registerTool(
    "agda_job_await_any",
    {
      description:
        "Wait for the FIRST of several pending jobs to finish; use after fanning work out across workspaces",
      inputSchema: jobAwaitAnyInputSchema,
    },
    async ({ jobs: ids, waitMs }, extra) => {
      try {
        const registry = await jobs();
        const outcome = await withProgress(
          extra as RequestExtra,
          "agda_job_await_any",
          progressIntervalMs,
          registry.awaitAny(ids, waitMs),
        );
        if (outcome.kind === "pending") {
          return structuredToolResult({
            status: "pending",
            jobs: outcome.jobs,
            guidance: "No job finished within the wait window; do other work and call again.",
          });
        }
        if (outcome.kind === "failed") {
          // The caller raced several jobs, so the error is useless without
          // saying which one produced it.
          return failedToolResult(outcome.error, { job: outcome.job });
        }
        return structuredToolResult({
          status: "completed",
          job: outcome.job,
          result: outcome.value,
        });
      } catch (error: unknown) {
        return failedToolResult(error);
      }
    },
  );

  server.registerTool(
    "agda_job_status",
    {
      description: "Report the state of a pending Agda job without waiting for it",
      inputSchema: jobIdInputSchema,
    },
    async ({ job }) => {
      try {
        return structuredToolResult(await (await jobs()).status(job));
      } catch (error: unknown) {
        return failedToolResult(error);
      }
    },
  );

  server.registerTool(
    "agda_job_cancel",
    {
      description: "Abort a pending Agda job and release its Agda command slot",
      inputSchema: jobIdInputSchema,
    },
    async ({ job }) => {
      try {
        return structuredToolResult(await (await jobs()).cancel(job));
      } catch (error: unknown) {
        return failedToolResult(error);
      }
    },
  );

  server.registerTool(
    "agda_job_list",
    {
      description: "List Agda jobs that are still running or awaiting collection",
      inputSchema: jobListInputSchema,
    },
    async () => {
      try {
        return structuredToolResult({ jobs: await (await jobs()).list() });
      } catch (error: unknown) {
        return failedToolResult(error);
      }
    },
  );

  return server;
}

function environmentOptions(environment: NodeJS.ProcessEnv): ServerOptions {
  const encoded = environment.AGDA_MCP_OPTIONS;
  if (encoded === undefined || encoded.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded) as unknown;
  } catch (error: unknown) {
    throw new ApplicationError("INVALID_ARGUMENT", "AGDA_MCP_OPTIONS must contain valid JSON", {
      cause: error,
    });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ApplicationError("INVALID_ARGUMENT", "AGDA_MCP_OPTIONS must contain a JSON object");
  }
  return parsed as ServerOptions;
}

async function clientWorkspaceRoots(server: McpServer): Promise<readonly string[]> {
  if (server.server.getClientCapabilities()?.roots === undefined) return [];
  const result = await server.server.listRoots();
  return result.roots
    .filter((root) => root.uri.startsWith("file:"))
    .map((root) => fileURLToPath(root.uri));
}

export interface StdioServerOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly cwd?: string;
}

export async function runStdioServer(options: StdioServerOptions = {}): Promise<void> {
  const environment = options.environment ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  let server!: McpServer;
  let servicePromise: Promise<AgdaApplicationService> | undefined;
  const serviceProvider = async (): Promise<AgdaApplicationService> => {
    servicePromise ??= (async () => {
      const configured = environmentOptions(environment);
      const roots = configured.workspaceRoots ?? (await clientWorkspaceRoots(server));
      return AgdaApplicationService.create(
        parseServerOptions({
          ...configured,
          workspaceRoots: roots.length === 0 ? [cwd] : roots,
        }),
      );
    })();
    return servicePromise;
  };
  // Resolved from configuration alone, so the defer window already covers the
  // first call — including the Agda discovery that service creation performs.
  const configured = environmentOptions(environment);
  const jobOptions = parseServerOptions({
    ...configured,
    workspaceRoots: configured.workspaceRoots ?? [cwd],
  });
  let registry: JobRegistry<NormalizedResult<unknown>> | undefined;
  const jobRegistryProvider: JobRegistryProvider = async () =>
    (registry ??= new JobRegistry<NormalizedResult<unknown>>({
      asyncMode: jobOptions.asyncMode,
      deferAfterMs: jobOptions.deferAfterMs,
      maxJobWaitMs: jobOptions.maxJobWaitMs,
      jobRetentionMs: jobOptions.jobRetentionMs,
      maxTrackedJobs: jobOptions.maxTrackedJobs,
      handleEntropyBytes: jobOptions.handleEntropyBytes,
    }));
  server = createAgdaMcpServer(
    serviceProvider,
    jobRegistryProvider,
    jobOptions.progressIntervalMs,
    jobOptions.includeRawByDefault,
  );
  const transport = new StdioServerTransport();
  transport.onclose = () => {
    registry?.cancelAll();
    void servicePromise?.then((service) => service.shutdown());
  };
  await server.connect(transport);
}
