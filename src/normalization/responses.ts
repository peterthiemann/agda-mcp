import type {
  BoundarySummary,
  ConstraintSummary,
  ContextEntry,
  ContextResult,
  Diagnostic,
  GoalSummary,
  InferredTypeResult,
  MetavariableSummary,
  NormalizedExpressionResult,
  SourceRange,
} from "../application/domain.js";
import { ApplicationError } from "../application/errors.js";
import { normalizeAgdaRange } from "./ranges.js";

export interface NormalizedGoalDraft {
  readonly interactionPoint: number;
  readonly range: SourceRange;
  readonly type: string;
}

export interface NormalizedLoadResponse {
  readonly checked: boolean;
  readonly diagnostics: readonly Diagnostic[];
  readonly goals: readonly NormalizedGoalDraft[];
  readonly invisibleMetavariables: readonly MetavariableSummary[];
  readonly warnings: readonly string[];
}

export interface NormalizedMetasResponse {
  readonly goals: readonly GoalSummary[];
  readonly metavariables: readonly MetavariableSummary[];
  readonly warnings: readonly string[];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function rendered(value: unknown): string {
  if (typeof value === "string") return value;
  const object = record(value);
  for (const key of ["message", "rendered", "type", "expr", "str"]) {
    if (typeof object?.[key] === "string") return object[key] as string;
  }
  return JSON.stringify(value) ?? String(value);
}

function interactionPoint(value: unknown): number | undefined {
  const object = record(value);
  const candidate = object?.id ?? object?.interactionPoint ?? object?.metaId;
  return typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0
    ? candidate
    : undefined;
}

function rangeFrom(value: unknown, source: string): SourceRange | undefined {
  const object = record(value);
  return normalizeAgdaRange(source, object?.range);
}

function diagnostic(
  severity: Diagnostic["severity"],
  value: unknown,
  source: string,
  modulePath: string,
): Diagnostic {
  const object = record(value);
  const range = rangeFrom(value, source);
  const code = typeof object?.kind === "string" ? object.kind : undefined;
  return Object.freeze({
    severity,
    message: rendered(value),
    file: modulePath,
    ...(range === undefined ? {} : { range }),
    ...(code === undefined ? {} : { code }),
  });
}

function visibleGoal(
  value: unknown,
  source: string,
  interactionRanges: ReadonlyMap<number, SourceRange>,
): NormalizedGoalDraft | undefined {
  const object = record(value);
  const constraint = record(object?.constraintObj);
  const id = interactionPoint(constraint) ?? interactionPoint(object);
  if (id === undefined) return undefined;
  const range = rangeFrom(constraint, source) ?? rangeFrom(object, source) ?? interactionRanges.get(id);
  if (range === undefined) {
    throw new ApplicationError("UNSUPPORTED_AGDA_PROTOCOL", "Visible Agda goal has no source range", {
      details: { interactionPoint: id },
    });
  }
  return Object.freeze({ interactionPoint: id, range, type: rendered(object?.type ?? value) });
}

function invisibleMeta(value: unknown, source: string): MetavariableSummary {
  const object = record(value);
  const range = rangeFrom(object?.constraintObj ?? value, source);
  return Object.freeze({
    type: rendered(object?.type ?? value),
    visibility: "invisible",
    ...(range === undefined ? {} : { range }),
  });
}

export function normalizeLoadResponse(
  events: readonly unknown[],
  source: string,
  modulePath: string,
): NormalizedLoadResponse {
  const interactionRanges = new Map<number, SourceRange>();
  for (const eventValue of events) {
    const event = record(eventValue);
    if (event?.kind !== "InteractionPoints" || !Array.isArray(event.interactionPoints)) continue;
    for (const pointValue of event.interactionPoints) {
      const id = interactionPoint(pointValue);
      const range = rangeFrom(pointValue, source);
      if (id !== undefined && range !== undefined) interactionRanges.set(id, range);
    }
  }

  const diagnostics: Diagnostic[] = [];
  const warnings: string[] = [];
  const goals = new Map<number, NormalizedGoalDraft>();
  const invisibleMetavariables: MetavariableSummary[] = [];

  for (const eventValue of events) {
    const event = record(eventValue);
    if (event?.kind !== "DisplayInfo") continue;
    const info = record(event.info);
    if (info?.kind === "Error") {
      diagnostics.push(diagnostic("error", info.error ?? info, source, modulePath));
      continue;
    }
    if (info?.kind !== "AllGoalsWarnings") continue;
    if (Array.isArray(info.errors)) {
      for (const value of info.errors) diagnostics.push(diagnostic("error", value, source, modulePath));
    }
    if (Array.isArray(info.warnings)) {
      for (const value of info.warnings) {
        const normalized = diagnostic("warning", value, source, modulePath);
        diagnostics.push(normalized);
        warnings.push(normalized.message);
      }
    }
    if (Array.isArray(info.visibleGoals)) {
      for (const value of info.visibleGoals) {
        const goal = visibleGoal(value, source, interactionRanges);
        if (goal !== undefined) goals.set(goal.interactionPoint, goal);
      }
    }
    if (Array.isArray(info.invisibleGoals)) {
      invisibleMetavariables.push(
        ...info.invisibleGoals.map((value) => invisibleMeta(value, source)),
      );
    }
  }

  return Object.freeze({
    checked: !diagnostics.some((entry) => entry.severity === "error"),
    diagnostics: Object.freeze(diagnostics),
    goals: Object.freeze([...goals.values()].sort((left, right) => left.interactionPoint - right.interactionPoint)),
    invisibleMetavariables: Object.freeze(invisibleMetavariables),
    warnings: Object.freeze(warnings),
  });
}

export function normalizeMetasResponse(
  events: readonly unknown[],
  source: string,
  modulePath: string,
  handleForInteractionPoint: (interactionPoint: number) => string | undefined,
): NormalizedMetasResponse {
  const load = normalizeLoadResponse(events, source, modulePath);
  const goals = load.goals.map((goal) => {
    const handle = handleForInteractionPoint(goal.interactionPoint);
    if (handle === undefined) {
      throw new ApplicationError(
        "UNSUPPORTED_AGDA_PROTOCOL",
        "Agda returned an interaction point outside the loaded goal state",
        { details: { interactionPoint: goal.interactionPoint } },
      );
    }
    return Object.freeze({ handle, range: goal.range, type: goal.type });
  });
  const visible: MetavariableSummary[] = goals.map((goal) =>
    Object.freeze({
      handle: goal.handle,
      range: goal.range,
      type: goal.type,
      visibility: "visible",
    }),
  );
  return Object.freeze({
    goals: Object.freeze(goals),
    metavariables: Object.freeze([...visible, ...load.invisibleMetavariables]),
    warnings: load.warnings,
  });
}

function displayInfo(events: readonly unknown[], kind: string): Record<string, unknown> | undefined {
  for (const eventValue of events) {
    const event = record(eventValue);
    const info = event?.kind === "DisplayInfo" ? record(event.info) : undefined;
    if (info?.kind === kind) return info;
  }
  return undefined;
}

function operationInfo(events: readonly unknown[], kind: string): Record<string, unknown> | undefined {
  const direct = displayInfo(events, kind);
  if (direct !== undefined) return direct;
  const goalSpecific = displayInfo(events, "GoalSpecific");
  const goalInfo = record(goalSpecific?.goalInfo);
  return goalInfo?.kind === kind ? goalInfo : undefined;
}

function throwPublishedError(events: readonly unknown[], operation: string): never {
  const error = displayInfo(events, "Error");
  throw new ApplicationError(
    error === undefined ? "UNSUPPORTED_AGDA_PROTOCOL" : "AGDA_COMMAND_REJECTED",
    error === undefined
      ? `Agda did not publish the required ${operation} response`
      : rendered(error.error ?? error),
    { details: { operation, events } },
  );
}

export function normalizeContextResponse(
  events: readonly unknown[],
  goalHandle: string,
): ContextResult {
  const specific = displayInfo(events, "GoalSpecific");
  const goalInfo = record(specific?.goalInfo);
  if (goalInfo?.kind !== "GoalType") throwPublishedError(events, "goal context");
  const entries: ContextEntry[] = (Array.isArray(goalInfo.entries) ? goalInfo.entries : []).map(
    (value) => {
      const entry = record(value);
      if (entry === undefined) {
        throw new ApplicationError("UNSUPPORTED_AGDA_PROTOCOL", "Agda context entry must be an object");
      }
      const reifiedName = rendered(entry.reifiedName ?? entry.originalName ?? "_");
      const originalName = typeof entry.originalName === "string" ? entry.originalName : undefined;
      return Object.freeze({
        reifiedName,
        type: rendered(entry.type ?? entry.binding ?? value),
        inScope: entry.inScope !== false,
        ...(originalName === undefined ? {} : { originalName }),
      });
    },
  );
  const boundaryValues = Array.isArray(goalInfo.boundary) ? goalInfo.boundary : [];
  const boundary: BoundarySummary | undefined =
    boundaryValues.length === 0
      ? undefined
      : Object.freeze({ rendered: boundaryValues.map(rendered).join("\n") });
  return Object.freeze({
    goal: goalHandle,
    goalType: rendered(goalInfo.type),
    context: Object.freeze(entries),
    ...(boundary === undefined ? {} : { boundary }),
  });
}

export function normalizeConstraintsResponse(
  events: readonly unknown[],
  source: string,
): readonly ConstraintSummary[] {
  const info = displayInfo(events, "Constraints");
  if (info === undefined) throwPublishedError(events, "constraints");
  const constraints = Array.isArray(info.constraints) ? info.constraints : [];
  return Object.freeze(
    constraints.map((value) => {
      const object = record(value);
      const range = rangeFrom(value, source);
      const kind = typeof object?.kind === "string" ? object.kind : undefined;
      return Object.freeze({
        rendered: rendered(object?.constraint ?? object?.message ?? value),
        ...(kind === undefined ? {} : { kind }),
        ...(range === undefined ? {} : { range }),
      });
    }),
  );
}

export function normalizeExpressionResponse(
  events: readonly unknown[],
  expression: string,
): NormalizedExpressionResult {
  const info = operationInfo(events, "NormalForm");
  if (info === undefined) throwPublishedError(events, "normal form");
  return Object.freeze({ expression, normalized: rendered(info.expr) });
}

export function normalizeInferredTypeResponse(
  events: readonly unknown[],
  expression: string,
): InferredTypeResult {
  const info = operationInfo(events, "InferredType");
  if (info === undefined) throwPublishedError(events, "inferred type");
  return Object.freeze({ expression, type: rendered(info.expr ?? info.type) });
}
