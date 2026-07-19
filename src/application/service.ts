import type {
  AutoRequest,
  AutoResult,
  CaseSplitRequest,
  ConstraintsResult,
  ContextResult,
  ContextsEntry,
  ContextsResult,
  EditPreviewResult,
  GoalsResult,
  InferTypeRequest,
  InferredTypeResult,
  LoadModuleRequest,
  MetavariablesResult,
  ModuleCheckResult,
  NormalizeExpressionRequest,
  NormalizedExpressionResult,
  NormalizedResult,
  OperationContext,
  RefineRequest,
  RetrieveContextRequest,
  RetrieveContextsRequest,
  ServerInfo,
  WorkspaceRequest,
  RewriteMode,
  NormalizationMode,
} from "./domain.js";
import type { AgdaService } from "./agdaService.js";
import type { ResolvedServerOptions } from "./config.js";
import { ApplicationError } from "./errors.js";
import {
  discoverAgdaInstallation,
  type AgdaInstallation,
  type InstallationDiscoveryDependencies,
} from "../discovery/agdaInstallation.js";
import { agda280Adapter } from "../protocol/adapters/agda-2.8.0.js";
import type { RawAgdaResponse } from "./domain.js";
import {
  WorkspaceSessionManager,
  type WorkspaceSessionManagerOptions,
} from "../sessions/sessionManager.js";
import {
  normalizeConstraintsResponse,
  normalizeContextResponse,
  normalizeExpressionResponse,
  normalizeInferredTypeResponse,
  normalizeMetasResponse,
} from "../normalization/responses.js";
import {
  planAutoEdit,
  planCaseSplitEdit,
  planRefineEdit,
} from "../normalization/editPlanner.js";

const REWRITE_MODES = new Set<RewriteMode>([
  "as_is",
  "simplified",
  "instantiated",
  "normalised",
  "head_normal",
]);
const NORMALIZATION_MODES = new Set<NormalizationMode>([
  "default",
  "ignore_abstract",
  "head",
  "use_show_instance",
]);

export interface AgdaApplicationServiceDependencies {
  readonly installation?: AgdaInstallation;
  readonly installationDiscovery?: InstallationDiscoveryDependencies;
  readonly processHostFactory?: WorkspaceSessionManagerOptions["processHostFactory"];
}

function emptyRaw(adapter: string): RawAgdaResponse {
  return Object.freeze({
    adapter,
    events: Object.freeze([]),
    complete: true,
    capturedBytes: 0,
    totalBytes: 0,
    omittedEventCount: 0,
    stderr: Object.freeze({
      chunks: Object.freeze([]),
      complete: true,
      capturedBytes: 0,
      totalBytes: 0,
    }),
  });
}

export class AgdaApplicationService implements AgdaService {
  readonly #options: ResolvedServerOptions;
  readonly #installation: AgdaInstallation;
  readonly #sessions: WorkspaceSessionManager;

  /** The fully resolved configuration this service was created with. */
  get options(): ResolvedServerOptions {
    return this.#options;
  }

  private constructor(
    options: ResolvedServerOptions,
    installation: AgdaInstallation,
    dependencies: AgdaApplicationServiceDependencies,
  ) {
    this.#options = options;
    this.#installation = installation;
    this.#sessions = new WorkspaceSessionManager({
      serverOptions: options,
      installation,
      adapter: agda280Adapter,
      ...(dependencies.processHostFactory === undefined
        ? {}
        : { processHostFactory: dependencies.processHostFactory }),
    });
  }

  static async create(
    options: ResolvedServerOptions,
    dependencies: AgdaApplicationServiceDependencies = {},
    signal?: AbortSignal,
  ): Promise<AgdaApplicationService> {
    const installation =
      dependencies.installation ??
      (await discoverAgdaInstallation(options, dependencies.installationDiscovery, signal));
    return new AgdaApplicationService(options, installation, dependencies);
  }

  async serverInfo(_context?: OperationContext): Promise<NormalizedResult<ServerInfo>> {
    return Object.freeze({
      data: Object.freeze({
        agda: Object.freeze({
          executable: this.#installation.executable,
          version: this.#installation.version,
          applicationDirectory: this.#installation.applicationDirectory,
          dataDirectory: this.#installation.dataDirectory,
          adapter: this.#installation.adapter,
          compatibility: this.#installation.compatibility,
        }),
        workspaceRoots: this.#options.workspaceRoots,
        workspaces: this.#sessions.summaries,
        capabilities: Object.freeze({
          sourceFormats: Object.freeze(["agda", "lagda", "lagda.md"] as const),
          mutatesFiles: false,
          metavariableScope: "interaction-backend",
        }),
      }),
      warnings: this.#installation.warnings,
      raw: emptyRaw(this.#installation.adapter),
    });
  }

  loadModule(
    request: LoadModuleRequest,
    context?: OperationContext,
  ): Promise<NormalizedResult<ModuleCheckResult>> {
    return this.#sessions.loadModule(request.modulePath, signalOptions(context));
  }

  typecheck(
    request: WorkspaceRequest,
    context?: OperationContext,
  ): Promise<NormalizedResult<ModuleCheckResult>> {
    return this.#sessions.typecheck(request.workspace, signalOptions(context));
  }

  async retrieveGoals(
    request: WorkspaceRequest,
    context?: OperationContext,
  ): Promise<NormalizedResult<GoalsResult>> {
    const session = this.#sessions.require(request.workspace);
    const query = await session.queryWorkspace(
      { kind: "metas", rewrite: "as_is" },
      signalOptions(context),
    );
    const normalized = normalizeMetasResponse(
      query.protocol.raw.events,
      query.sourceText,
      query.modulePath,
      (interactionPoint) => session.goalHandle(interactionPoint),
    );
    return Object.freeze({
      data: Object.freeze({
        workspace: request.workspace,
        revision: query.revision,
        goals: normalized.goals,
      }),
      warnings: Object.freeze([...this.#installation.warnings, ...normalized.warnings]),
      raw: query.protocol.raw,
    });
  }

  async retrieveContext(
    request: RetrieveContextRequest,
    context?: OperationContext,
  ): Promise<NormalizedResult<ContextResult>> {
    validateRewriteMode(request.rewrite);
    const session = this.#sessions.requireGoal(request.goal);
    const query = await session.queryGoal(
      request.goal,
      (goal) => ({
        kind: "goalTypeContext",
        interactionPoint: goal.interactionPoint,
        range: goal.protocolRange,
        ...(request.rewrite === undefined ? {} : { rewrite: request.rewrite }),
      }),
      signalOptions(context),
    );
    return result(
      normalizeContextResponse(query.protocol.raw.events, request.goal),
      query.protocol.raw,
      this.#installation.warnings,
    );
  }

  /**
   * Fetch several goal contexts in one call. Agda still processes them one at a
   * time — the interaction process is single-threaded — but the caller pays for
   * one round trip instead of one per goal, and a bad handle only fails its own
   * entry rather than the whole batch.
   */
  async retrieveContexts(
    request: RetrieveContextsRequest,
    context?: OperationContext,
  ): Promise<NormalizedResult<ContextsResult>> {
    const entries: ContextsEntry[] = [];
    const transcripts: RawAgdaResponse[] = [];
    const warnings: string[] = [];

    for (const goal of request.goals) {
      context?.signal?.throwIfAborted();
      try {
        const single = await this.retrieveContext(
          { goal, ...(request.rewrite === undefined ? {} : { rewrite: request.rewrite }) },
          context,
        );
        entries.push(Object.freeze({ goal, ok: true, context: single.data }));
        transcripts.push(single.raw);
        warnings.push(...single.warnings);
      } catch (error: unknown) {
        const applicationError =
          error instanceof ApplicationError
            ? error
            : new ApplicationError("AGDA_COMMAND_REJECTED", "Goal context lookup failed", {
                cause: error,
              });
        entries.push(
          Object.freeze({
            goal,
            ok: false,
            error: Object.freeze({
              code: applicationError.code,
              message: applicationError.message,
              recoverable: applicationError.recoverable,
            }),
          }),
        );
      }
    }

    const succeeded = entries.filter((entry) => entry.ok).length;
    return result(
      Object.freeze({
        requested: request.goals.length,
        succeeded,
        failed: entries.length - succeeded,
        contexts: Object.freeze(entries),
      }),
      transcripts[0] ?? emptyRaw(this.#installation.adapter),
      [...this.#installation.warnings, ...warnings],
    );
  }

  async retrieveConstraints(
    request: WorkspaceRequest,
    context?: OperationContext,
  ): Promise<NormalizedResult<ConstraintsResult>> {
    const session = this.#sessions.require(request.workspace);
    const query = await session.queryWorkspace({ kind: "constraints" }, signalOptions(context));
    return result(
      Object.freeze({
        workspace: request.workspace,
        constraints: normalizeConstraintsResponse(query.protocol.raw.events, query.sourceText),
      }),
      query.protocol.raw,
      this.#installation.warnings,
    );
  }

  async caseSplit(
    request: CaseSplitRequest,
    context?: OperationContext,
  ): Promise<NormalizedResult<EditPreviewResult>> {
    validateGoalHandle(request.goal);
    validateOptionalString(request.variables, "variables");
    const session = this.#sessions.requireGoal(request.goal);
    const transaction = await session.previewGoal(
      request.goal,
      (goal) => ({
        kind: "makeCase",
        interactionPoint: goal.interactionPoint,
        range: goal.protocolRange,
        ...(request.variables === undefined ? {} : { variables: request.variables }),
      }),
      planCaseSplitEdit,
      signalOptions(context),
    );
    return transformationResult(
      transaction.proposal.edits,
      transaction.restored,
      transaction.raw,
    );
  }

  async refine(
    request: RefineRequest,
    context?: OperationContext,
  ): Promise<NormalizedResult<EditPreviewResult>> {
    validateGoalHandle(request.goal);
    validateOptionalString(request.expression, "expression");
    if (request.usePatternLambda !== undefined && typeof request.usePatternLambda !== "boolean") {
      throw new ApplicationError("INVALID_ARGUMENT", "usePatternLambda must be a boolean");
    }
    const session = this.#sessions.requireGoal(request.goal);
    const transaction = await session.previewGoal(
      request.goal,
      (goal) => ({
        kind: "refineOrIntro",
        interactionPoint: goal.interactionPoint,
        range: goal.protocolRange,
        ...(request.expression === undefined ? {} : { expression: request.expression }),
        ...(request.usePatternLambda === undefined
          ? {}
          : { usePatternLambda: request.usePatternLambda }),
      }),
      (events, planningContext) =>
        planRefineEdit(events, planningContext, request.expression),
      signalOptions(context),
    );
    return transformationResult(
      transaction.proposal.edits,
      transaction.restored,
      transaction.raw,
    );
  }

  async auto(
    request: AutoRequest,
    context?: OperationContext,
  ): Promise<NormalizedResult<AutoResult>> {
    validateGoalHandle(request.goal);
    validateOptionalString(request.query, "query");
    const session = this.#sessions.requireGoal(request.goal);
    const transaction = await session.previewGoal(
      request.goal,
      (goal) => ({
        kind: "autoOne",
        interactionPoint: goal.interactionPoint,
        range: goal.protocolRange,
        ...(request.query === undefined ? {} : { query: request.query }),
      }),
      planAutoEdit,
      signalOptions(context),
    );
    const base = editPreviewData(transaction.proposal.edits, transaction.restored);
    return Object.freeze({
      data: Object.freeze({
        ...base,
        found: transaction.proposal.found,
        ...(transaction.proposal.message === undefined
          ? {}
          : { message: transaction.proposal.message }),
      }),
      warnings: transaction.restored.warnings,
      raw: transaction.raw,
    });
  }

  async normalizeExpression(
    request: NormalizeExpressionRequest,
    context?: OperationContext,
  ): Promise<NormalizedResult<NormalizedExpressionResult>> {
    const selector = validateExpressionSelector(request);
    validateNormalizationMode(request.mode);
    if (selector.kind === "workspace") {
      const session = this.#sessions.require(selector.handle);
      const query = await session.queryWorkspace(
        {
          kind: "computeTopLevel",
          expression: request.expression,
          ...(request.mode === undefined ? {} : { mode: request.mode }),
        },
        signalOptions(context),
      );
      return result(
        normalizeExpressionResponse(query.protocol.raw.events, request.expression),
        query.protocol.raw,
        this.#installation.warnings,
      );
    }
    const session = this.#sessions.requireGoal(selector.handle);
    const query = await session.queryGoal(
      selector.handle,
      (goal) => ({
        kind: "compute",
        interactionPoint: goal.interactionPoint,
        range: goal.protocolRange,
        expression: request.expression,
        ...(request.mode === undefined ? {} : { mode: request.mode }),
      }),
      signalOptions(context),
    );
    return result(
      normalizeExpressionResponse(query.protocol.raw.events, request.expression),
      query.protocol.raw,
      this.#installation.warnings,
    );
  }

  async inferType(
    request: InferTypeRequest,
    context?: OperationContext,
  ): Promise<NormalizedResult<InferredTypeResult>> {
    const selector = validateExpressionSelector(request);
    validateRewriteMode(request.rewrite);
    if (selector.kind === "workspace") {
      const session = this.#sessions.require(selector.handle);
      const query = await session.queryWorkspace(
        {
          kind: "inferTopLevel",
          expression: request.expression,
          ...(request.rewrite === undefined ? {} : { rewrite: request.rewrite }),
        },
        signalOptions(context),
      );
      return result(
        normalizeInferredTypeResponse(query.protocol.raw.events, request.expression),
        query.protocol.raw,
        this.#installation.warnings,
      );
    }
    const session = this.#sessions.requireGoal(selector.handle);
    const query = await session.queryGoal(
      selector.handle,
      (goal) => ({
        kind: "infer",
        interactionPoint: goal.interactionPoint,
        range: goal.protocolRange,
        expression: request.expression,
        ...(request.rewrite === undefined ? {} : { rewrite: request.rewrite }),
      }),
      signalOptions(context),
    );
    return result(
      normalizeInferredTypeResponse(query.protocol.raw.events, request.expression),
      query.protocol.raw,
      this.#installation.warnings,
    );
  }

  async queryMetavariables(
    request: WorkspaceRequest,
    context?: OperationContext,
  ): Promise<NormalizedResult<MetavariablesResult>> {
    const session = this.#sessions.require(request.workspace);
    const query = await session.queryWorkspace(
      { kind: "metas", rewrite: "as_is" },
      signalOptions(context),
    );
    const normalized = normalizeMetasResponse(
      query.protocol.raw.events,
      query.sourceText,
      query.modulePath,
      (interactionPoint) => session.goalHandle(interactionPoint),
    );
    return Object.freeze({
      data: Object.freeze({
        workspace: request.workspace,
        metavariables: normalized.metavariables,
      }),
      warnings: Object.freeze([...this.#installation.warnings, ...normalized.warnings]),
      raw: query.protocol.raw,
    });
  }

  async shutdown(): Promise<void> {
    await this.#sessions.terminate();
  }
}

function signalOptions(
  context: OperationContext | undefined,
): { signal?: AbortSignal; timeoutMs?: number } {
  return {
    ...(context?.signal === undefined ? {} : { signal: context.signal }),
    ...(context?.timeoutMs === undefined ? {} : { timeoutMs: context.timeoutMs }),
  };
}

function validateGoalHandle(goal: string): void {
  if (typeof goal !== "string" || goal.trim() === "") {
    throw new ApplicationError("INVALID_ARGUMENT", "goal must be a non-empty string");
  }
}

function validateOptionalString(value: unknown, name: string): void {
  if (value !== undefined && typeof value !== "string") {
    throw new ApplicationError("INVALID_ARGUMENT", `${name} must be a string`);
  }
}

function editPreviewData(
  edits: EditPreviewResult["edits"],
  restored: NormalizedResult<ModuleCheckResult>,
): EditPreviewResult {
  return Object.freeze({
    workspace: restored.data.workspace,
    modulePath: restored.data.modulePath,
    edits,
    restoredRevision: restored.data.revision,
    goals: restored.data.goals,
  });
}

function transformationResult(
  edits: EditPreviewResult["edits"],
  restored: NormalizedResult<ModuleCheckResult>,
  raw: RawAgdaResponse,
): NormalizedResult<EditPreviewResult> {
  return Object.freeze({
    data: editPreviewData(edits, restored),
    warnings: restored.warnings,
    raw,
  });
}

function result<T>(
  data: T,
  raw: NormalizedResult<T>["raw"],
  warnings: readonly string[],
): NormalizedResult<T> {
  return Object.freeze({ data, warnings: Object.freeze([...warnings]), raw });
}

function validateRewriteMode(mode: RewriteMode | undefined): void {
  if (mode !== undefined && !REWRITE_MODES.has(mode)) {
    throw new ApplicationError("INVALID_ARGUMENT", "Invalid rewrite mode", { details: { mode } });
  }
}

function validateNormalizationMode(mode: NormalizationMode | undefined): void {
  if (mode !== undefined && !NORMALIZATION_MODES.has(mode)) {
    throw new ApplicationError("INVALID_ARGUMENT", "Invalid normalization mode", {
      details: { mode },
    });
  }
}

export function validateExpressionSelector(
  request: Pick<NormalizeExpressionRequest, "expression" | "workspace" | "goal">,
): { readonly kind: "workspace" | "goal"; readonly handle: string } {
  if (typeof request.expression !== "string" || request.expression.trim() === "") {
    throw new ApplicationError("INVALID_ARGUMENT", "expression must be a non-empty string");
  }
  const workspace = typeof request.workspace === "string" && request.workspace.trim() !== "";
  const goal = typeof request.goal === "string" && request.goal.trim() !== "";
  if (workspace === goal) {
    throw new ApplicationError(
      "INVALID_ARGUMENT",
      "Exactly one of workspace or goal must be provided",
    );
  }
  return workspace
    ? Object.freeze({ kind: "workspace", handle: request.workspace as string })
    : Object.freeze({ kind: "goal", handle: request.goal as string });
}
