import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

import type { SourceFormat } from "../application/domain.js";
import type {
  ResolvedServerOptions,
  ResolvedWorkspaceOverrideOptions,
} from "../application/config.js";
import { assertSafeAgdaFlags } from "../application/config.js";
import { ApplicationError } from "../application/errors.js";
import { requireSourceFormat } from "../normalization/sourceFormats.js";
import type { AgdaInstallation } from "./agdaInstallation.js";
import { readAgdaLibraryFile, type AgdaLibraryFile } from "./agdaLib.js";

export interface EffectiveLoadConfiguration {
  readonly includePaths: readonly string[];
  readonly libraries: readonly string[];
  readonly libraryFile?: string;
  readonly flags: readonly string[];
  readonly arguments: readonly string[];
}

export interface CommandOutputPolicy {
  readonly commandTimeoutMs: number;
  readonly rawResponseLimitBytes: number;
  readonly stderrReturnLimitBytes: number;
  readonly maxCommandOutputBytes: number;
}

export interface ModuleDiscoveryPlan {
  readonly modulePath: string;
  readonly sourceFormat: SourceFormat;
  readonly workspaceRoot: string;
  readonly projectRoot: string;
  readonly projectFile?: AgdaLibraryFile;
  readonly installation: AgdaInstallation;
  readonly launchArguments: readonly ["--interaction-json"];
  readonly commandPolicy: CommandOutputPolicy;
  readonly load: EffectiveLoadConfiguration;
}

function invalid(message: string, details: Readonly<Record<string, unknown>> = {}): never {
  throw new ApplicationError("INVALID_ARGUMENT", message, { details });
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function resolveConfiguredPaths(values: readonly string[], base: string): string[] {
  return values.map((value) => path.resolve(base, value));
}

async function canonicalDirectory(directory: string, label: string): Promise<string> {
  if (!path.isAbsolute(directory)) invalid(`${label} must be absolute: ${directory}`, { directory });
  try {
    const canonical = await realpath(directory);
    const metadata = await stat(canonical);
    if (!metadata.isDirectory()) invalid(`${label} is not a directory: ${directory}`, { directory });
    return canonical;
  } catch (error: unknown) {
    if (error instanceof ApplicationError) throw error;
    throw new ApplicationError("INVALID_ARGUMENT", `${label} is not accessible: ${directory}`, {
      details: { directory },
      cause: error,
    });
  }
}

async function canonicalModule(modulePath: string): Promise<string> {
  if (!path.isAbsolute(modulePath)) invalid(`modulePath must be absolute: ${modulePath}`, { modulePath });
  requireSourceFormat(modulePath);
  try {
    const canonical = await realpath(modulePath);
    const metadata = await stat(canonical);
    if (!metadata.isFile()) invalid(`modulePath is not a regular file: ${modulePath}`, { modulePath });
    requireSourceFormat(canonical);
    return canonical;
  } catch (error: unknown) {
    if (error instanceof ApplicationError) throw error;
    throw new ApplicationError("INVALID_ARGUMENT", `modulePath is not accessible: ${modulePath}`, {
      details: { modulePath },
      cause: error,
    });
  }
}

async function canonicalWorkspaceRoots(roots: readonly string[]): Promise<string[]> {
  if (roots.length === 0) invalid("At least one workspace root is required");
  return unique(await Promise.all(roots.map((root) => canonicalDirectory(root, "Workspace root"))));
}

function selectWorkspace(modulePath: string, roots: readonly string[]): string {
  const containing = roots.filter((root) => isWithin(root, modulePath));
  containing.sort((left, right) => right.length - left.length || left.localeCompare(right));
  const selected = containing[0];
  if (selected === undefined) {
    throw new ApplicationError("PATH_OUTSIDE_WORKSPACE", `Module is outside configured workspace roots: ${modulePath}`, {
      details: { modulePath, workspaceRoots: roots },
    });
  }
  return selected;
}

async function findNearestAgdaLibrary(modulePath: string, workspaceRoot: string): Promise<string | undefined> {
  let directory = path.dirname(modulePath);
  while (isWithin(workspaceRoot, directory)) {
    const entries = await readdir(directory, { withFileTypes: true });
    const candidates = entries
      .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".agda-lib"))
      .map((entry) => entry.name)
      .sort();
    if (candidates.length > 1) {
      invalid(`Multiple .agda-lib files found in ${directory}`, { directory, candidates });
    }
    if (candidates[0] !== undefined) return path.join(directory, candidates[0]);
    if (directory === workspaceRoot) break;
    directory = path.dirname(directory);
  }
  return undefined;
}

async function selectWorkspaceOverride(
  overrides: readonly ResolvedWorkspaceOverrideOptions[],
  workspaceRoots: readonly string[],
  workspaceRoot: string,
): Promise<ResolvedWorkspaceOverrideOptions | undefined> {
  let selected: ResolvedWorkspaceOverrideOptions | undefined;
  const seenRoots = new Set<string>();
  for (const override of overrides) {
    const canonicalRoot = await canonicalDirectory(override.root, "Workspace override root");
    if (!workspaceRoots.includes(canonicalRoot)) {
      invalid(`Workspace override root is not a configured workspace: ${override.root}`, {
        root: override.root,
      });
    }
    if (seenRoots.has(canonicalRoot)) {
      invalid(`Multiple workspace overrides resolve to ${canonicalRoot}`, { root: canonicalRoot });
    }
    seenRoots.add(canonicalRoot);
    if (canonicalRoot !== workspaceRoot) continue;
    selected = override;
  }
  return selected;
}

function buildLoadArguments(configuration: Omit<EffectiveLoadConfiguration, "arguments">): string[] {
  const arguments_: string[] = [];
  for (const includePath of configuration.includePaths) arguments_.push(`--include-path=${includePath}`);
  for (const library of configuration.libraries) arguments_.push(`--library=${library}`);
  if (configuration.libraryFile !== undefined) {
    arguments_.push(`--library-file=${configuration.libraryFile}`);
  }
  arguments_.push(...configuration.flags);
  return arguments_;
}

export async function discoverModulePlan(
  modulePath: string,
  options: ResolvedServerOptions,
  installation: AgdaInstallation,
): Promise<ModuleDiscoveryPlan> {
  const canonicalPath = await canonicalModule(modulePath);
  const sourceFormat = requireSourceFormat(canonicalPath);
  const workspaceRoots = await canonicalWorkspaceRoots(options.workspaceRoots);
  const workspaceRoot = selectWorkspace(canonicalPath, workspaceRoots);
  const projectFilePath = await findNearestAgdaLibrary(canonicalPath, workspaceRoot);
  const projectFile =
    projectFilePath === undefined ? undefined : await readAgdaLibraryFile(projectFilePath);
  const projectRoot = projectFile?.directory ?? workspaceRoot;
  const override = await selectWorkspaceOverride(
    options.workspaceOverrides,
    workspaceRoots,
    workspaceRoot,
  );

  const includePaths = unique([
    ...(projectFile?.includePaths ?? []),
    ...resolveConfiguredPaths(options.includePaths, projectRoot),
    ...resolveConfiguredPaths(override?.includePaths ?? [], workspaceRoot),
  ]);
  const libraries = unique([
    ...(projectFile?.dependencies ?? []),
    ...options.libraries,
    ...(override?.libraries ?? []),
  ]);
  const flags = [
    ...(projectFile?.flags ?? []),
    ...options.additionalFlags,
    ...(override?.additionalFlags ?? []),
  ];
  assertSafeAgdaFlags(flags, options.allowAgdaExec, projectFile?.file ?? "resolved Agda flags");

  const configuredLibraryFile = override?.libraryFile ?? options.libraryFile;
  const libraryFile =
    configuredLibraryFile === undefined
      ? undefined
      : path.resolve(override?.libraryFile === undefined ? projectRoot : workspaceRoot, configuredLibraryFile);
  const partial = {
    includePaths: Object.freeze(includePaths),
    libraries: Object.freeze(libraries),
    flags: Object.freeze(flags),
    ...(libraryFile === undefined ? {} : { libraryFile }),
  };
  const load: EffectiveLoadConfiguration = Object.freeze({
    ...partial,
    arguments: Object.freeze(buildLoadArguments(partial)),
  });
  const plan: ModuleDiscoveryPlan = {
    modulePath: canonicalPath,
    sourceFormat,
    workspaceRoot,
    projectRoot,
    installation,
    launchArguments: Object.freeze(["--interaction-json"]),
    commandPolicy: Object.freeze({
      commandTimeoutMs: options.commandTimeoutMs,
      rawResponseLimitBytes: options.rawResponseLimitBytes,
      stderrReturnLimitBytes: options.stderrReturnLimitBytes,
      maxCommandOutputBytes: options.maxCommandOutputBytes,
    }),
    load,
    ...(projectFile === undefined ? {} : { projectFile }),
  };
  return Object.freeze(plan);
}
