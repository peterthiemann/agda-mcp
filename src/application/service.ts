import type {
  AutoRequest,
  AutoResult,
  CaseSplitRequest,
  ConstraintsResult,
  ContextResult,
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
  ServerInfo,
  WorkspaceRequest,
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
    return this.#sessions.loadModule(request.modulePath, context?.signal);
  }

  typecheck(
    request: WorkspaceRequest,
    context?: OperationContext,
  ): Promise<NormalizedResult<ModuleCheckResult>> {
    return this.#sessions.typecheck(request.workspace, context?.signal);
  }

  retrieveGoals(
    _request: WorkspaceRequest,
    _context?: OperationContext,
  ): Promise<NormalizedResult<GoalsResult>> {
    return notImplemented("agda_retrieve_goals");
  }

  retrieveContext(
    _request: RetrieveContextRequest,
    _context?: OperationContext,
  ): Promise<NormalizedResult<ContextResult>> {
    return notImplemented("agda_retrieve_context");
  }

  retrieveConstraints(
    _request: WorkspaceRequest,
    _context?: OperationContext,
  ): Promise<NormalizedResult<ConstraintsResult>> {
    return notImplemented("agda_retrieve_constraints");
  }

  caseSplit(
    _request: CaseSplitRequest,
    _context?: OperationContext,
  ): Promise<NormalizedResult<EditPreviewResult>> {
    return notImplemented("agda_case_split");
  }

  refine(
    _request: RefineRequest,
    _context?: OperationContext,
  ): Promise<NormalizedResult<EditPreviewResult>> {
    return notImplemented("agda_refine");
  }

  auto(
    _request: AutoRequest,
    _context?: OperationContext,
  ): Promise<NormalizedResult<AutoResult>> {
    return notImplemented("agda_auto");
  }

  normalizeExpression(
    _request: NormalizeExpressionRequest,
    _context?: OperationContext,
  ): Promise<NormalizedResult<NormalizedExpressionResult>> {
    return notImplemented("agda_normalize_expression");
  }

  inferType(
    _request: InferTypeRequest,
    _context?: OperationContext,
  ): Promise<NormalizedResult<InferredTypeResult>> {
    return notImplemented("agda_infer_type");
  }

  queryMetavariables(
    _request: WorkspaceRequest,
    _context?: OperationContext,
  ): Promise<NormalizedResult<MetavariablesResult>> {
    return notImplemented("agda_query_metavariables");
  }

  async shutdown(): Promise<void> {
    await this.#sessions.terminate();
  }
}

function notImplemented<T>(tool: string): Promise<T> {
  return Promise.reject(
    new ApplicationError("UNSUPPORTED_AGDA_PROTOCOL", `${tool} is not implemented yet`, {
      details: { tool },
    }),
  );
}
