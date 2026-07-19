import type { SourcePosition, SourceRange } from "../application/domain.js";
import { ApplicationError } from "../application/errors.js";

interface NativePosition {
  readonly pos?: unknown;
  readonly offset?: unknown;
  readonly line?: unknown;
  readonly col?: unknown;
  readonly column?: unknown;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new ApplicationError("UNSUPPORTED_AGDA_PROTOCOL", `${label} must be a positive integer`, {
      details: { value },
    });
  }
  return value as number;
}

function utf16OffsetFromCodePointOffset(source: string, codePointOffset: number): number {
  let codePoints = 0;
  let utf16Offset = 0;
  for (const character of source) {
    if (codePoints === codePointOffset) return utf16Offset;
    codePoints += 1;
    utf16Offset += character.length;
  }
  if (codePoints === codePointOffset) return utf16Offset;
  throw new ApplicationError("UNSUPPORTED_AGDA_PROTOCOL", "Agda position exceeds the source snapshot", {
    details: { codePointOffset, sourceCodePoints: codePoints },
  });
}

function utf16OffsetFromLineColumn(source: string, line: number, column: number): number {
  let currentLine = 1;
  let currentColumn = 1;
  let utf16Offset = 0;
  if (line === 1 && column === 1) return 0;
  for (const character of source) {
    if (currentLine === line && currentColumn === column) return utf16Offset;
    utf16Offset += character.length;
    if (character === "\n") {
      currentLine += 1;
      currentColumn = 1;
    } else {
      currentColumn += 1;
    }
  }
  if (currentLine === line && currentColumn === column) return utf16Offset;
  throw new ApplicationError("UNSUPPORTED_AGDA_PROTOCOL", "Agda line/column exceeds the source snapshot", {
    details: { line, column },
  });
}

export function normalizeAgdaPosition(source: string, value: unknown): SourcePosition {
  const native = record(value) as NativePosition | undefined;
  if (native === undefined) {
    throw new ApplicationError("UNSUPPORTED_AGDA_PROTOCOL", "Agda position must be an object");
  }
  const line = positiveInteger(native.line, "position.line");
  const column = positiveInteger(native.col ?? native.column, "position.column");
  const absolute = native.pos ?? native.offset;
  const utf16Offset =
    absolute === undefined
      ? utf16OffsetFromLineColumn(source, line, column)
      : utf16OffsetFromCodePointOffset(source, positiveInteger(absolute, "position.pos") - 1);
  return Object.freeze({ line, column, utf16Offset });
}

export function normalizeAgdaRange(source: string, value: unknown): SourceRange | undefined {
  const intervals = Array.isArray(value) ? value : [];
  const interval = record(intervals[0]);
  if (interval === undefined) return undefined;
  const start = normalizeAgdaPosition(source, interval.start);
  const end = normalizeAgdaPosition(source, interval.end);
  if (end.utf16Offset < start.utf16Offset) {
    throw new ApplicationError("UNSUPPORTED_AGDA_PROTOCOL", "Agda range end precedes its start");
  }
  return Object.freeze({ start, end });
}
