import { ApplicationError } from "./errors.js";

export const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
export const DEFAULT_LOAD_TIMEOUT_MS = 120_000;
export const DEFAULT_QUERY_TIMEOUT_MS = 30_000;
export const DEFAULT_TRANSFORMATION_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_QUEUED_COMMANDS = 64;
export const DEFAULT_RAW_RESPONSE_LIMIT_BYTES = 128 * 1024;
export const DEFAULT_STDERR_RETURN_LIMIT_BYTES = 32 * 1024;
export const DEFAULT_MAX_COMMAND_OUTPUT_BYTES = 16 * 1024 * 1024;

export interface WorkspaceOverrideOptions {
  readonly root: string;
  readonly includePaths?: readonly string[];
  readonly libraries?: readonly string[];
  readonly libraryFile?: string;
  readonly additionalFlags?: readonly string[];
}

export interface ServerOptions {
  readonly agdaExecutable?: string;
  readonly workspaceRoots?: readonly string[];
  readonly includePaths?: readonly string[];
  readonly libraries?: readonly string[];
  readonly libraryFile?: string;
  readonly additionalFlags?: readonly string[];
  readonly workspaceOverrides?: readonly WorkspaceOverrideOptions[];
  readonly commandTimeoutMs?: number;
  readonly loadTimeoutMs?: number;
  readonly queryTimeoutMs?: number;
  readonly transformationTimeoutMs?: number;
  readonly maxQueuedCommands?: number;
  readonly rawResponseLimitBytes?: number;
  readonly stderrReturnLimitBytes?: number;
  readonly maxCommandOutputBytes?: number;
  readonly allowAgdaExec?: boolean;
}

export interface ResolvedWorkspaceOverrideOptions {
  readonly root: string;
  readonly includePaths: readonly string[];
  readonly libraries: readonly string[];
  readonly libraryFile?: string;
  readonly additionalFlags: readonly string[];
}

export interface ResolvedServerOptions {
  readonly agdaExecutable: string;
  readonly workspaceRoots: readonly string[];
  readonly includePaths: readonly string[];
  readonly libraries: readonly string[];
  readonly libraryFile?: string;
  readonly additionalFlags: readonly string[];
  readonly workspaceOverrides: readonly ResolvedWorkspaceOverrideOptions[];
  readonly commandTimeoutMs: number;
  readonly loadTimeoutMs: number;
  readonly queryTimeoutMs: number;
  readonly transformationTimeoutMs: number;
  readonly maxQueuedCommands: number;
  readonly rawResponseLimitBytes: number;
  readonly stderrReturnLimitBytes: number;
  readonly maxCommandOutputBytes: number;
  readonly allowAgdaExec: boolean;
}

const SERVER_OPTION_KEYS = new Set([
  "agdaExecutable",
  "workspaceRoots",
  "includePaths",
  "libraries",
  "libraryFile",
  "additionalFlags",
  "workspaceOverrides",
  "commandTimeoutMs",
  "loadTimeoutMs",
  "queryTimeoutMs",
  "transformationTimeoutMs",
  "maxQueuedCommands",
  "rawResponseLimitBytes",
  "stderrReturnLimitBytes",
  "maxCommandOutputBytes",
  "allowAgdaExec",
]);

const WORKSPACE_OPTION_KEYS = new Set([
  "root",
  "includePaths",
  "libraries",
  "libraryFile",
  "additionalFlags",
]);

function invalid(message: string, details: Readonly<Record<string, unknown>> = {}): never {
  throw new ApplicationError("INVALID_ARGUMENT", message, { details });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnknownKeys(record: Record<string, unknown>, allowed: ReadonlySet<string>, path: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      invalid(`Unknown option ${path}.${key}`, { path: `${path}.${key}` });
    }
  }
}

function optionalNonEmptyString(record: Record<string, unknown>, key: string, path: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    invalid(`${path}.${key} must be a non-empty string`, { path: `${path}.${key}` });
  }
  return value;
}

function stringArray(record: Record<string, unknown>, key: string, path: string): readonly string[] {
  const value = record[key];
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) {
    invalid(`${path}.${key} must be an array of non-empty strings`, { path: `${path}.${key}` });
  }
  const result = value.map((entry, index) => {
    if (typeof entry !== "string" || entry.trim() === "") {
      invalid(`${path}.${key}[${index}] must be a non-empty string`, {
        path: `${path}.${key}[${index}]`,
      });
    }
    return entry;
  });
  return Object.freeze(result);
}

function positiveInteger(
  record: Record<string, unknown>,
  key: string,
  fallback: number,
  path: string,
): number {
  const value = record[key];
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    invalid(`${path}.${key} must be a positive safe integer`, { path: `${path}.${key}` });
  }
  return value;
}

function booleanValue(record: Record<string, unknown>, key: string, fallback: boolean, path: string): boolean {
  const value = record[key];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    invalid(`${path}.${key} must be a boolean`, { path: `${path}.${key}` });
  }
  return value;
}

export function containsAllowExec(flags: readonly string[]): boolean {
  return flags.some((flag) => flag === "--allow-exec" || flag.startsWith("--allow-exec="));
}

export function assertSafeAgdaFlags(
  flags: readonly string[],
  allowAgdaExec: boolean,
  origin: string,
): void {
  if (!allowAgdaExec && containsAllowExec(flags)) {
    invalid(`${origin} requests --allow-exec, but allowAgdaExec is false`, { origin });
  }
}

function parseWorkspaceOverride(value: unknown, index: number): ResolvedWorkspaceOverrideOptions {
  const path = `options.workspaceOverrides[${index}]`;
  if (!isRecord(value)) invalid(`${path} must be an object`, { path });
  rejectUnknownKeys(value, WORKSPACE_OPTION_KEYS, path);
  const root = optionalNonEmptyString(value, "root", path);
  if (root === undefined) invalid(`${path}.root is required`, { path: `${path}.root` });
  const libraryFile = optionalNonEmptyString(value, "libraryFile", path);
  const result: ResolvedWorkspaceOverrideOptions = {
    root,
    includePaths: stringArray(value, "includePaths", path),
    libraries: stringArray(value, "libraries", path),
    additionalFlags: stringArray(value, "additionalFlags", path),
    ...(libraryFile === undefined ? {} : { libraryFile }),
  };
  return Object.freeze(result);
}

export function parseServerOptions(input: unknown = {}): ResolvedServerOptions {
  if (!isRecord(input)) invalid("Initialization options must be an object", { path: "options" });
  rejectUnknownKeys(input, SERVER_OPTION_KEYS, "options");

  const agdaExecutable = optionalNonEmptyString(input, "agdaExecutable", "options") ?? "agda";
  const libraryFile = optionalNonEmptyString(input, "libraryFile", "options");
  const workspaceOverridesValue = input.workspaceOverrides;
  if (workspaceOverridesValue !== undefined && !Array.isArray(workspaceOverridesValue)) {
    invalid("options.workspaceOverrides must be an array", { path: "options.workspaceOverrides" });
  }
  const workspaceOverrides = Object.freeze(
    (workspaceOverridesValue ?? []).map((entry, index) => parseWorkspaceOverride(entry, index)),
  );
  const allowAgdaExec = booleanValue(input, "allowAgdaExec", false, "options");
  const additionalFlags = stringArray(input, "additionalFlags", "options");
  assertSafeAgdaFlags(additionalFlags, allowAgdaExec, "options.additionalFlags");
  for (const override of workspaceOverrides) {
    assertSafeAgdaFlags(
      override.additionalFlags,
      allowAgdaExec,
      `workspace override ${override.root}`,
    );
  }

  const rawResponseLimitBytes = positiveInteger(
    input,
    "rawResponseLimitBytes",
    DEFAULT_RAW_RESPONSE_LIMIT_BYTES,
    "options",
  );
  const stderrReturnLimitBytes = positiveInteger(
    input,
    "stderrReturnLimitBytes",
    DEFAULT_STDERR_RETURN_LIMIT_BYTES,
    "options",
  );
  const maxCommandOutputBytes = positiveInteger(
    input,
    "maxCommandOutputBytes",
    DEFAULT_MAX_COMMAND_OUTPUT_BYTES,
    "options",
  );
  if (rawResponseLimitBytes > maxCommandOutputBytes) {
    invalid("rawResponseLimitBytes cannot exceed maxCommandOutputBytes");
  }
  if (stderrReturnLimitBytes > maxCommandOutputBytes) {
    invalid("stderrReturnLimitBytes cannot exceed maxCommandOutputBytes");
  }

  const legacyTimeoutConfigured = input.commandTimeoutMs !== undefined;
  const commandTimeoutMs = positiveInteger(
    input,
    "commandTimeoutMs",
    DEFAULT_COMMAND_TIMEOUT_MS,
    "options",
  );

  const result: ResolvedServerOptions = {
    agdaExecutable,
    workspaceRoots: stringArray(input, "workspaceRoots", "options"),
    includePaths: stringArray(input, "includePaths", "options"),
    libraries: stringArray(input, "libraries", "options"),
    additionalFlags,
    workspaceOverrides,
    commandTimeoutMs,
    loadTimeoutMs: positiveInteger(
      input,
      "loadTimeoutMs",
      legacyTimeoutConfigured ? commandTimeoutMs : DEFAULT_LOAD_TIMEOUT_MS,
      "options",
    ),
    queryTimeoutMs: positiveInteger(
      input,
      "queryTimeoutMs",
      legacyTimeoutConfigured ? commandTimeoutMs : DEFAULT_QUERY_TIMEOUT_MS,
      "options",
    ),
    transformationTimeoutMs: positiveInteger(
      input,
      "transformationTimeoutMs",
      legacyTimeoutConfigured ? commandTimeoutMs : DEFAULT_TRANSFORMATION_TIMEOUT_MS,
      "options",
    ),
    maxQueuedCommands: positiveInteger(
      input,
      "maxQueuedCommands",
      DEFAULT_MAX_QUEUED_COMMANDS,
      "options",
    ),
    rawResponseLimitBytes,
    stderrReturnLimitBytes,
    maxCommandOutputBytes,
    allowAgdaExec,
    ...(libraryFile === undefined ? {} : { libraryFile }),
  };
  return Object.freeze(result);
}
