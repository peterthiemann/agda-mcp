import type { SourceFormat } from "../application/domain.js";
import { ApplicationError } from "../application/errors.js";

const SUPPORTED_SUFFIXES: readonly [suffix: string, format: SourceFormat][] = [
  [".lagda.md", "lagda.md"],
  [".lagda", "lagda"],
  [".agda", "agda"],
];

export const SUPPORTED_SOURCE_FORMATS: readonly SourceFormat[] = Object.freeze([
  "agda",
  "lagda",
  "lagda.md",
]);

export function sourceFormatForPath(filePath: string): SourceFormat | undefined {
  for (const [suffix, format] of SUPPORTED_SUFFIXES) {
    if (filePath.endsWith(suffix)) return format;
  }
  return undefined;
}

export function requireSourceFormat(filePath: string): SourceFormat {
  const format = sourceFormatForPath(filePath);
  if (format === undefined) {
    throw new ApplicationError(
      "INVALID_ARGUMENT",
      `Unsupported Agda source path: ${filePath}. Expected .agda, .lagda, or .lagda.md`,
      { details: { filePath } },
    );
  }
  return format;
}
