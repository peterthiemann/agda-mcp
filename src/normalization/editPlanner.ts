import type {
  GoalSummary,
  SourceFormat,
  TextEdit,
} from "../application/domain.js";
import { ApplicationError } from "../application/errors.js";
import { analyzeCodeRegions, requireContainingCodeRegion } from "./codeRegions.js";
import { sourceRangeFromUtf16Offsets } from "./ranges.js";

export interface EditPlanningContext {
  readonly modulePath: string;
  readonly sourceFormat: SourceFormat;
  readonly source: string;
  readonly sourceFingerprint: string;
  readonly goalRange: GoalSummary["range"];
}

export interface EditPlan {
  readonly edits: readonly TextEdit[];
}

export interface AutoEditPlan extends EditPlan {
  readonly found: boolean;
  readonly message?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function eventOfKind(events: readonly unknown[], kind: string): Record<string, unknown> | undefined {
  return events.map(record).find((event) => event?.kind === kind);
}

function displayInfoOfKind(events: readonly unknown[], kind: string): Record<string, unknown> | undefined {
  for (const eventValue of events) {
    const event = record(eventValue);
    const info = event?.kind === "DisplayInfo" ? record(event.info) : undefined;
    if (info?.kind === kind) return info;
  }
  return undefined;
}

function edit(context: EditPlanningContext, start: number, end: number, replacement: string): TextEdit {
  const regions = analyzeCodeRegions(context.source, context.sourceFormat);
  requireContainingCodeRegion(regions, start, end);
  return Object.freeze({
    file: context.modulePath,
    range: sourceRangeFromUtf16Offsets(context.source, start, end),
    replacement,
    expectedSourceFingerprint: context.sourceFingerprint,
  });
}

function goalEdit(context: EditPlanningContext, replacement: string): TextEdit {
  return edit(
    context,
    context.goalRange.start.utf16Offset,
    context.goalRange.end.utf16Offset,
    replacement,
  );
}

function giveReplacement(events: readonly unknown[], submitted?: string): string | undefined {
  const action = eventOfKind(events, "GiveAction");
  const result = record(action?.giveResult);
  return typeof result?.str === "string"
    ? result.str
    : typeof action?.replacement === "string"
      ? action.replacement
      : action !== undefined && submitted !== undefined
        ? result?.paren === true
          ? `(${submitted})`
          : submitted
        : undefined;
}

function publishedError(events: readonly unknown[], operation: string): never {
  const error = displayInfoOfKind(events, "Error");
  const message = record(error?.error)?.message ?? error?.message;
  throw new ApplicationError(
    error === undefined ? "UNSUPPORTED_AGDA_PROTOCOL" : "AGDA_COMMAND_REJECTED",
    typeof message === "string" ? message : `Agda did not publish a ${operation} proposal`,
    { details: { operation, events } },
  );
}

export function planRefineEdit(
  events: readonly unknown[],
  context: EditPlanningContext,
  submittedExpression?: string,
): EditPlan {
  const replacement = giveReplacement(events, submittedExpression);
  if (replacement === undefined) publishedError(events, "refine");
  return Object.freeze({ edits: Object.freeze([goalEdit(context, replacement)]) });
}

export function planAutoEdit(
  events: readonly unknown[],
  context: EditPlanningContext,
): AutoEditPlan {
  const replacement = giveReplacement(events);
  if (replacement !== undefined) {
    return Object.freeze({ found: true, edits: Object.freeze([goalEdit(context, replacement)]) });
  }
  const auto = displayInfoOfKind(events, "Auto");
  if (auto !== undefined) {
    const message = typeof auto.message === "string" ? auto.message : "No solution found";
    return Object.freeze({ found: false, message, edits: Object.freeze([]) });
  }
  publishedError(events, "auto");
}

export function planCaseSplitEdit(
  events: readonly unknown[],
  context: EditPlanningContext,
): EditPlan {
  const makeCase = eventOfKind(events, "MakeCase");
  if (makeCase === undefined || !Array.isArray(makeCase.clauses)) publishedError(events, "case split");
  const clauses = makeCase.clauses.filter((value): value is string => typeof value === "string");
  if (clauses.length !== makeCase.clauses.length || clauses.length === 0) {
    throw new ApplicationError("UNSUPPORTED_EDIT_SHAPE", "Case split returned no usable clauses");
  }
  const goalStart = context.goalRange.start.utf16Offset;
  const lineStart = context.source.lastIndexOf("\n", Math.max(0, goalStart - 1)) + 1;
  const newline = context.source.indexOf("\n", goalStart);
  let lineEnd = newline === -1 ? context.source.length : newline;
  if (lineEnd > lineStart && context.source[lineEnd - 1] === "\r") lineEnd -= 1;
  const indentation = /^\s*/u.exec(context.source.slice(lineStart, lineEnd))?.[0] ?? "";
  const replacement = clauses.map((clause) => `${indentation}${clause.trimStart()}`).join("\n");
  return Object.freeze({ edits: Object.freeze([edit(context, lineStart, lineEnd, replacement)]) });
}

export function applyTextEdit(source: string, editValue: TextEdit): string {
  return (
    source.slice(0, editValue.range.start.utf16Offset) +
    editValue.replacement +
    source.slice(editValue.range.end.utf16Offset)
  );
}
