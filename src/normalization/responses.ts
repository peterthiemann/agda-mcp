import type {
  Diagnostic,
  MetavariableSummary,
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
