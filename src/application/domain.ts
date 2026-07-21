export type WorkspaceHandle = string;
export type GoalHandle = string;

export type SourceFormat = "agda" | "lagda" | "lagda.md";

export interface SourcePosition {
  readonly line: number;
  readonly column: number;
  readonly utf16Offset: number;
}

export interface SourceRange {
  readonly start: SourcePosition;
  readonly end: SourcePosition;
}

export type DiagnosticSeverity = "error" | "warning" | "information";

export interface Diagnostic {
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  readonly file?: string;
  readonly range?: SourceRange;
  readonly code?: string;
}

export interface GoalSummary {
  readonly handle: GoalHandle;
  readonly range: SourceRange;
  readonly type: string;
}

export interface MetavariableSummary {
  readonly handle?: GoalHandle;
  readonly range?: SourceRange;
  readonly type: string;
  readonly visibility: "visible" | "invisible";
}

export interface ContextEntry {
  readonly originalName?: string;
  readonly reifiedName: string;
  readonly type: string;
  readonly inScope: boolean;
}

export interface ConstraintSummary {
  readonly kind?: string;
  readonly rendered: string;
  readonly range?: SourceRange;
}

export interface BoundarySummary {
  readonly rendered: string;
}

export interface TextEdit {
  readonly file: string;
  readonly range: SourceRange;
  readonly replacement: string;
  readonly expectedSourceFingerprint: string;
}

export interface CapturedStderr {
  readonly chunks: readonly string[];
  readonly complete: boolean;
  readonly capturedBytes: number;
  readonly totalBytes: number;
}

export interface RawCommandTranscript {
  readonly events: readonly unknown[];
  readonly complete: boolean;
  readonly capturedBytes: number;
  readonly totalBytes: number;
  readonly omittedEventCount: number;
  readonly omittedSha256?: string;
  readonly stderr: CapturedStderr;
}

export interface RawAgdaResponse extends RawCommandTranscript {
  readonly adapter: string;
  readonly restore?: RawCommandTranscript;
  readonly typecheck?: RawCommandTranscript;
}

export interface NormalizedResult<T> {
  readonly data: T;
  readonly warnings: readonly string[];
  readonly raw: RawAgdaResponse;
}

export type CompatibilityStatus = "supported" | "unverified";

export interface AgdaVersionInfo {
  readonly executable: string;
  readonly version: string;
  readonly applicationDirectory: string;
  readonly dataDirectory: string;
  readonly adapter: string;
  readonly compatibility: CompatibilityStatus;
}

export interface WorkspaceSessionSummary {
  readonly handle: WorkspaceHandle;
  readonly root: string;
  readonly activeModule?: string;
  readonly revision: number;
  readonly lifecycle: "starting" | "ready" | "recovering" | "stopped";
}

export interface ServerInfo {
  readonly agda: AgdaVersionInfo;
  readonly workspaceRoots: readonly string[];
  readonly workspaces: readonly WorkspaceSessionSummary[];
  readonly capabilities: {
    readonly sourceFormats: readonly SourceFormat[];
    readonly mutatesFiles: "opt-in";
    readonly metavariableScope: "interaction-backend";
  };
}

export interface ModuleCheckResult {
  readonly workspace: WorkspaceHandle;
  readonly workspaceRoot: string;
  readonly projectRoot: string;
  readonly modulePath: string;
  readonly sourceFormat: SourceFormat;
  readonly revision: number;
  readonly sourceFingerprint: string;
  readonly checked: boolean;
  readonly diagnostics: readonly Diagnostic[];
  readonly goals: readonly GoalSummary[];
  readonly invisibleMetavariables: readonly MetavariableSummary[];
  /** Present when the caller requested compound goal inspection. */
  readonly contexts?: ContextsResult;
  readonly agda: AgdaVersionInfo;
}

export interface GoalsResult {
  readonly workspace: WorkspaceHandle;
  readonly revision: number;
  readonly goals: readonly GoalSummary[];
}

export interface ContextResult {
  readonly goal: GoalHandle;
  readonly goalType: string;
  readonly context: readonly ContextEntry[];
  readonly boundary?: BoundarySummary;
}

export interface ContextsEntry {
  readonly goal: GoalHandle;
  readonly ok: boolean;
  readonly context?: ContextResult;
  readonly error?: {
    readonly code: string;
    readonly message: string;
    readonly recoverable: boolean;
  };
}

export interface ContextsResult {
  readonly requested: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly contexts: readonly ContextsEntry[];
}

export interface ConstraintsResult {
  readonly workspace: WorkspaceHandle;
  readonly constraints: readonly ConstraintSummary[];
}

export interface EditPreviewResult {
  readonly workspace: WorkspaceHandle;
  readonly modulePath: string;
  readonly edits: readonly TextEdit[];
  /** True only when guarded direct-edit mode changed the source file. */
  readonly applied: boolean;
  /** Verdict from the canonical reload after preview or direct application. */
  readonly checked: boolean;
  readonly diagnostics: readonly Diagnostic[];
  readonly sourceFingerprint: string;
  readonly restoredRevision: number;
  readonly goals: readonly GoalSummary[];
}

export interface AutoResult extends EditPreviewResult {
  readonly found: boolean;
  readonly message?: string;
}

export interface NormalizedExpressionResult {
  readonly expression: string;
  readonly normalized: string;
}

export interface InferredTypeResult {
  readonly expression: string;
  readonly type: string;
}

export interface MetavariablesResult {
  readonly workspace: WorkspaceHandle;
  readonly metavariables: readonly MetavariableSummary[];
}

export type RewriteMode =
  | "as_is"
  | "simplified"
  | "instantiated"
  | "normalised"
  | "head_normal";

export type NormalizationMode =
  | "default"
  | "ignore_abstract"
  | "head"
  | "use_show_instance";

export interface LoadModuleRequest {
  readonly modulePath: string;
  readonly includeContexts?: boolean;
}

export interface WorkspaceRequest {
  readonly workspace: WorkspaceHandle;
}

export interface TypecheckRequest extends WorkspaceRequest {
  readonly includeContexts?: boolean;
}

export interface GoalRequest {
  readonly goal: GoalHandle;
}

export interface RetrieveContextRequest extends GoalRequest {
  readonly rewrite?: RewriteMode;
}

export interface RetrieveContextsRequest {
  readonly goals: readonly GoalHandle[];
  readonly rewrite?: RewriteMode;
}

export interface CaseSplitRequest extends GoalRequest {
  readonly variables?: string;
  readonly apply?: boolean;
}

export interface RefineRequest extends GoalRequest {
  readonly expression?: string;
  readonly usePatternLambda?: boolean;
  readonly apply?: boolean;
}

export interface AutoRequest extends GoalRequest {
  readonly query?: string;
  readonly apply?: boolean;
}

export interface ScopedExpressionRequest {
  readonly expression: string;
  readonly workspace?: WorkspaceHandle;
  readonly goal?: GoalHandle;
}

export interface NormalizeExpressionRequest extends ScopedExpressionRequest {
  readonly mode?: NormalizationMode;
}

export interface InferTypeRequest extends ScopedExpressionRequest {
  readonly rewrite?: RewriteMode;
}

export interface OperationContext {
  readonly signal?: AbortSignal;
  /** Per-call override of the configured Agda command timeout. */
  readonly timeoutMs?: number;
}
