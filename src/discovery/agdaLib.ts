import { readFile } from "node:fs/promises";
import path from "node:path";

import { ApplicationError } from "../application/errors.js";

export interface AgdaLibraryFile {
  readonly file: string;
  readonly directory: string;
  readonly name?: string;
  readonly includePaths: readonly string[];
  readonly dependencies: readonly string[];
  readonly flags: readonly string[];
  readonly unknownFields: Readonly<Record<string, readonly string[]>>;
}

interface ParsedFields {
  readonly fields: Map<string, string[]>;
}

function malformed(file: string, line: number, message: string): never {
  throw new ApplicationError("INVALID_ARGUMENT", `Malformed .agda-lib ${file}:${line}: ${message}`, {
    details: { file, line },
  });
}

function parseFields(contents: string, file: string): ParsedFields {
  const fields = new Map<string, string[]>();
  let currentField: string | undefined;
  const lines = contents.replace(/^\uFEFF/, "").split(/\r?\n/u);

  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    const trimmed = line.trim();
    if (trimmed === "") continue;

    if (/^\s/u.test(line)) {
      if (currentField === undefined) malformed(file, lineNumber, "continuation without a field");
      fields.get(currentField)?.push(trimmed);
      continue;
    }

    if (trimmed.startsWith("--")) continue;

    const match = /^([A-Za-z][A-Za-z0-9-]*):(?:\s*(.*))?$/u.exec(line);
    if (match === null) malformed(file, lineNumber, "expected 'field: value'");
    const field = match[1]?.toLowerCase();
    if (field === undefined) malformed(file, lineNumber, "missing field name");
    currentField = field;
    const values = fields.get(field) ?? [];
    const inlineValue = match[2]?.trim();
    if (inlineValue !== undefined && inlineValue !== "") values.push(inlineValue);
    fields.set(field, values);
  }
  return { fields };
}

function tokens(values: readonly string[]): string[] {
  return values.flatMap((value) => value.split(/\s+/u).filter(Boolean));
}

export function parseAgdaLibraryFile(contents: string, file: string): AgdaLibraryFile {
  const absoluteFile = path.resolve(file);
  const directory = path.dirname(absoluteFile);
  const { fields } = parseFields(contents, absoluteFile);
  const names = tokens(fields.get("name") ?? []);
  if (names.length > 1) malformed(absoluteFile, 1, "name must contain exactly one value");

  const known = new Set(["name", "include", "depend", "flags"]);
  const unknownFields: Record<string, readonly string[]> = {};
  for (const [field, values] of fields) {
    if (!known.has(field)) unknownFields[field] = Object.freeze([...values]);
  }

  const includePaths = tokens(fields.get("include") ?? []).map((includePath) =>
    path.resolve(directory, includePath),
  );
  const result: AgdaLibraryFile = {
    file: absoluteFile,
    directory,
    includePaths: Object.freeze(includePaths),
    dependencies: Object.freeze(tokens(fields.get("depend") ?? [])),
    flags: Object.freeze(tokens(fields.get("flags") ?? [])),
    unknownFields: Object.freeze(unknownFields),
    ...(names[0] === undefined ? {} : { name: names[0] }),
  };
  return Object.freeze(result);
}

export async function readAgdaLibraryFile(file: string): Promise<AgdaLibraryFile> {
  try {
    return parseAgdaLibraryFile(await readFile(file, "utf8"), file);
  } catch (error: unknown) {
    if (error instanceof ApplicationError) throw error;
    throw new ApplicationError("INVALID_ARGUMENT", `Could not read .agda-lib file: ${file}`, {
      details: { file },
      cause: error,
    });
  }
}
