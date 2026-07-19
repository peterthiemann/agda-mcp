import { constants as fsConstants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

import type { CompatibilityStatus } from "../application/domain.js";
import type { ResolvedServerOptions } from "../application/config.js";
import { ApplicationError } from "../application/errors.js";

export const BASELINE_AGDA_VERSION = "2.8.0";
export const BASELINE_ADAPTER = "agda-2.8.0";

export interface AgdaInstallation {
  readonly executable: string;
  readonly version: string;
  readonly applicationDirectory: string;
  readonly dataDirectory: string;
  readonly adapter: string;
  readonly compatibility: CompatibilityStatus;
  readonly warnings: readonly string[];
}

export interface ProbeResult {
  readonly stdout: string;
  readonly stderr: string;
}

export type ProbeRunner = (
  executable: string,
  arguments_: readonly string[],
  options: {
    readonly timeoutMs: number;
    readonly maxBufferBytes: number;
    readonly signal?: AbortSignal;
  },
) => Promise<ProbeResult>;

export interface InstallationDiscoveryDependencies {
  readonly environment?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly runner?: ProbeRunner;
}

const execFileAsync = promisify(execFile);

const defaultRunner: ProbeRunner = async (executable, arguments_, options) => {
  const result = await execFileAsync(executable, [...arguments_], {
    encoding: "utf8",
    shell: false,
    timeout: options.timeoutMs,
    maxBuffer: options.maxBufferBytes,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  return { stdout: result.stdout, stderr: result.stderr };
};

function executableCandidates(command: string, platform: NodeJS.Platform, environment: NodeJS.ProcessEnv): string[] {
  if (platform !== "win32" || path.extname(command) !== "") return [command];
  const pathExt = environment.PATHEXT ?? ".COM;.EXE;.BAT;.CMD";
  return pathExt.split(";").filter(Boolean).map((extension) => `${command}${extension.toLowerCase()}`);
}

async function accessibleExecutable(candidate: string, platform: NodeJS.Platform): Promise<string | undefined> {
  try {
    await access(candidate, platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
    return await realpath(candidate);
  } catch {
    return undefined;
  }
}

export async function resolveAgdaExecutable(
  configuredExecutable: string,
  dependencies: Pick<InstallationDiscoveryDependencies, "environment" | "platform"> = {},
): Promise<string> {
  const environment = dependencies.environment ?? process.env;
  const platform = dependencies.platform ?? process.platform;
  const hasPathSeparator = configuredExecutable.includes("/") || configuredExecutable.includes("\\");

  if (hasPathSeparator || path.isAbsolute(configuredExecutable)) {
    const resolved = await accessibleExecutable(path.resolve(configuredExecutable), platform);
    if (resolved !== undefined) return resolved;
    throw new ApplicationError("AGDA_NOT_FOUND", `Agda executable is not accessible: ${configuredExecutable}`, {
      details: { configuredExecutable },
    });
  }

  const searchPath = environment.PATH ?? environment.Path ?? environment.path ?? "";
  for (const directory of searchPath.split(path.delimiter)) {
    if (directory === "") continue;
    for (const candidateName of executableCandidates(configuredExecutable, platform, environment)) {
      const resolved = await accessibleExecutable(path.join(directory, candidateName), platform);
      if (resolved !== undefined) return resolved;
    }
  }

  throw new ApplicationError("AGDA_NOT_FOUND", `Could not resolve ${configuredExecutable} from PATH`, {
    details: { configuredExecutable },
  });
}

async function runProbe(
  runner: ProbeRunner,
  executable: string,
  argument: string,
  timeoutMs: number,
  maxBufferBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  try {
    const result = await runner(executable, [argument], {
      timeoutMs,
      maxBufferBytes,
      ...(signal === undefined ? {} : { signal }),
    });
    const value = result.stdout.trim();
    if (value === "") {
      throw new Error(`Probe ${argument} returned empty stdout`);
    }
    return value;
  } catch (error: unknown) {
    if (error instanceof ApplicationError) throw error;
    throw new ApplicationError("AGDA_COMMAND_REJECTED", `Agda probe ${argument} failed`, {
      details: { executable, argument },
      cause: error,
    });
  }
}

export async function discoverAgdaInstallation(
  options: ResolvedServerOptions,
  dependencies: InstallationDiscoveryDependencies = {},
  signal?: AbortSignal,
): Promise<AgdaInstallation> {
  const executable = await resolveAgdaExecutable(options.agdaExecutable, dependencies);
  const runner = dependencies.runner ?? defaultRunner;
  const probe = (argument: string): Promise<string> =>
    runProbe(runner, executable, argument, options.probeTimeoutMs, options.probeMaxBufferBytes, signal);
  const [version, applicationDirectory, dataDirectory] = await Promise.all([
    probe("--numeric-version"),
    probe("--print-agda-app-dir"),
    probe("--print-agda-data-dir"),
  ]);
  const compatibility: CompatibilityStatus =
    version === BASELINE_AGDA_VERSION ? "supported" : "unverified";
  const warnings =
    compatibility === "supported"
      ? []
      : [
          `Agda ${version} is unverified; using the ${BASELINE_AGDA_VERSION} interaction adapter`,
        ];

  return Object.freeze({
    executable,
    version,
    applicationDirectory,
    dataDirectory,
    adapter: BASELINE_ADAPTER,
    compatibility,
    warnings: Object.freeze(warnings),
  });
}
