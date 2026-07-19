import type { SourceFormat } from "../application/domain.js";
import { ApplicationError } from "../application/errors.js";

export interface CodeRegion {
  readonly startUtf16Offset: number;
  readonly endUtf16Offset: number;
}

interface SourceLine {
  readonly start: number;
  readonly contentEnd: number;
  readonly end: number;
  readonly text: string;
}

function lines(source: string): SourceLine[] {
  const result: SourceLine[] = [];
  let start = 0;
  while (start < source.length) {
    const newline = source.indexOf("\n", start);
    const end = newline === -1 ? source.length : newline + 1;
    const contentEnd = newline === -1 ? end : newline > start && source[newline - 1] === "\r" ? newline - 1 : newline;
    result.push({ start, contentEnd, end, text: source.slice(start, contentEnd) });
    start = end;
  }
  if (source.length === 0) result.push({ start: 0, contentEnd: 0, end: 0, text: "" });
  return result;
}

function invalid(message: string): never {
  throw new ApplicationError("UNSUPPORTED_EDIT_SHAPE", message);
}

function texRegions(source: string): CodeRegion[] {
  const result: CodeRegion[] = [];
  let open: number | undefined;
  for (const line of lines(source)) {
    if (/^\s*\\begin\{code\}\s*$/u.test(line.text)) {
      if (open !== undefined) invalid("Nested literate TeX code regions are unsupported");
      open = line.end;
    } else if (/^\s*\\end\{code\}\s*$/u.test(line.text)) {
      if (open === undefined) invalid("Unmatched literate TeX code-region terminator");
      result.push(Object.freeze({ startUtf16Offset: open, endUtf16Offset: line.start }));
      open = undefined;
    }
  }
  if (open !== undefined) invalid("Unterminated literate TeX code region");
  return result;
}

interface MarkdownFence {
  readonly marker: "`" | "~";
  readonly length: number;
  readonly contentStart: number;
}

function markdownRegions(source: string): CodeRegion[] {
  const result: CodeRegion[] = [];
  let open: MarkdownFence | undefined;
  for (const line of lines(source)) {
    if (open === undefined) {
      const match = /^\s*(`{3,}|~{3,})\s*agda(?:\s+.*)?$/iu.exec(line.text);
      if (match?.[1] !== undefined) {
        open = {
          marker: match[1][0] as "`" | "~",
          length: match[1].length,
          contentStart: line.end,
        };
      }
      continue;
    }
    const close = /^\s*(`{3,}|~{3,})\s*$/u.exec(line.text)?.[1];
    if (close !== undefined && close[0] === open.marker && close.length >= open.length) {
      result.push(
        Object.freeze({
          startUtf16Offset: open.contentStart,
          endUtf16Offset: line.start,
        }),
      );
      open = undefined;
    }
  }
  if (open !== undefined) invalid("Unterminated literate Markdown Agda fence");
  return result;
}

export function analyzeCodeRegions(source: string, format: SourceFormat): readonly CodeRegion[] {
  if (format === "agda") {
    return Object.freeze([
      Object.freeze({ startUtf16Offset: 0, endUtf16Offset: source.length }),
    ]);
  }
  const regions = format === "lagda" ? texRegions(source) : markdownRegions(source);
  if (regions.length === 0) invalid(`No Agda code region found in ${format} source`);
  return Object.freeze(regions);
}

export function requireContainingCodeRegion(
  regions: readonly CodeRegion[],
  startUtf16Offset: number,
  endUtf16Offset: number,
): CodeRegion {
  const matches = regions.filter(
    (region) =>
      startUtf16Offset >= region.startUtf16Offset && endUtf16Offset <= region.endUtf16Offset,
  );
  if (matches.length !== 1) {
    invalid("Proposed edit does not map to exactly one Agda code region");
  }
  return matches[0] as CodeRegion;
}
