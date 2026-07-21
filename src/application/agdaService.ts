import type {
  AutoRequest,
  AutoResult,
  CaseSplitRequest,
  ConstraintsResult,
  ContextResult,
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
  TypecheckRequest,
  WorkspaceRequest,
} from "./domain.js";

export interface AgdaService {
  serverInfo(context?: OperationContext): Promise<NormalizedResult<ServerInfo>>;
  loadModule(
    request: LoadModuleRequest,
    context?: OperationContext,
  ): Promise<NormalizedResult<ModuleCheckResult>>;
  typecheck(
    request: TypecheckRequest,
    context?: OperationContext,
  ): Promise<NormalizedResult<ModuleCheckResult>>;
  retrieveGoals(
    request: WorkspaceRequest,
    context?: OperationContext,
  ): Promise<NormalizedResult<GoalsResult>>;
  retrieveContext(
    request: RetrieveContextRequest,
    context?: OperationContext,
  ): Promise<NormalizedResult<ContextResult>>;
  retrieveContexts(
    request: RetrieveContextsRequest,
    context?: OperationContext,
  ): Promise<NormalizedResult<ContextsResult>>;
  retrieveConstraints(
    request: WorkspaceRequest,
    context?: OperationContext,
  ): Promise<NormalizedResult<ConstraintsResult>>;
  caseSplit(
    request: CaseSplitRequest,
    context?: OperationContext,
  ): Promise<NormalizedResult<EditPreviewResult>>;
  refine(
    request: RefineRequest,
    context?: OperationContext,
  ): Promise<NormalizedResult<EditPreviewResult>>;
  auto(
    request: AutoRequest,
    context?: OperationContext,
  ): Promise<NormalizedResult<AutoResult>>;
  normalizeExpression(
    request: NormalizeExpressionRequest,
    context?: OperationContext,
  ): Promise<NormalizedResult<NormalizedExpressionResult>>;
  inferType(
    request: InferTypeRequest,
    context?: OperationContext,
  ): Promise<NormalizedResult<InferredTypeResult>>;
  queryMetavariables(
    request: WorkspaceRequest,
    context?: OperationContext,
  ): Promise<NormalizedResult<MetavariablesResult>>;
}
