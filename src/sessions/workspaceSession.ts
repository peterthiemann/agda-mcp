import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open, realpath } from "node:fs/promises";

import type {
  AgdaVersionInfo,
  GoalSummary,
  ModuleCheckResult,
  NormalizedResult,
  RawAgdaResponse,
  RawCommandTranscript,
  SourceFormat,
  WorkspaceHandle,
  WorkspaceSessionSummary,
} from "../application/domain.js";
import { ApplicationError } from "../application/errors.js";
import type { AgdaInstallation } from "../discovery/agdaInstallation.js";
import type { ModuleDiscoveryPlan } from "../discovery/projectResolver.js";
import { normalizeLoadResponse } from "../normalization/responses.js";
import type {
  AgdaCommand,
  AgdaCommandContext,
  AgdaProtocolAdapter,
  AgdaProtocolRange,
} from "../protocol/adapter.js";
import {
  AgdaProcessHost,
  type AgdaProcessHostOptions,
  type SendCommandOptions,
} from "../protocol/processHost.js";
import type { ProtocolCommandResult } from "../protocol/transcript.js";
import { SerializedCommandQueue } from "./commandQueue.js";
import { GoalHandleTable, type GoalRecord } from "./goalHandles.js";

export type ProcessHostFactory = (options: AgdaProcessHostOptions) => AgdaProcessHost;

interface SourceSnapshot {
  readonly bytes: Buffer;
  readonly text: string;
  readonly fingerprint: string;
}

interface ActiveModuleState {
  readonly plan: ModuleDiscoveryPlan;
  readonly snapshot: SourceSnapshot;
  readonly interactionPoints: ReadonlySet<number>;
  readonly goalHandles: ReadonlyMap<number, string>;
  readonly result: NormalizedResult<ModuleCheckResult>;
}

export interface SessionQueryState {
  readonly workspace: WorkspaceHandle;
  readonly modulePath: string;
  readonly revision: number;
  readonly sourceFingerprint: string;
  readonly sourceText: string;
  readonly protocol: ProtocolCommandResult;
}

export interface GoalSessionQueryState extends SessionQueryState {
  readonly goal: GoalRecord;
}

export interface PreviewPlanningContext {
  readonly modulePath: string;
  readonly sourceFormat: SourceFormat;
  readonly source: string;
  readonly sourceFingerprint: string;
  readonly goalRange: GoalSummary["range"];
}

export interface PreviewTransactionResult<T> {
  readonly proposal: T;
  readonly restored: NormalizedResult<ModuleCheckResult>;
  readonly raw: RawAgdaResponse;
}

export interface WorkspaceSessionOptions {
  readonly plan: ModuleDiscoveryPlan;
  readonly adapter: AgdaProtocolAdapter;
  readonly processHostFactory?: ProcessHostFactory;
}

function versionInfo(installation: AgdaInstallation): AgdaVersionInfo {
  return Object.freeze({
    executable: installation.executable,
    version: installation.version,
    applicationDirectory: installation.applicationDirectory,
    dataDirectory: installation.dataDirectory,
    adapter: installation.adapter,
    compatibility: installation.compatibility,
  });
}

async function readSnapshot(file: string): Promise<SourceSnapshot> {
  const canonical = await realpath(file);
  if (canonical !== file) {
    throw new ApplicationError("PATH_OUTSIDE_WORKSPACE", "The active module path was replaced by a symlink", {
      details: { modulePath: file, actualPath: canonical },
    });
  }
  let handle;
  try {
    handle = await open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new ApplicationError("INVALID_ARGUMENT", "The active module is not a regular file", {
        details: { modulePath: file },
      });
    }
    const bytes = await handle.readFile();
    return Object.freeze({
      bytes,
      text: bytes.toString("utf8"),
      fingerprint: createHash("sha256").update(bytes).digest("hex"),
    });
  } finally {
    await handle?.close();
  }
}

function codePointPosition(text: string, utf16Offset: number): number {
  return [...text.slice(0, utf16Offset)].length + 1;
}

function protocolRange(file: string, source: string, range: GoalSummary["range"]): AgdaProtocolRange {
  return Object.freeze({
    file,
    start: Object.freeze({
      offset: codePointPosition(source, range.start.utf16Offset),
      line: range.start.line,
      column: range.start.column,
    }),
    end: Object.freeze({
      offset: codePointPosition(source, range.end.utf16Offset),
      line: range.end.line,
      column: range.end.column,
    }),
  });
}

export class WorkspaceSession {
  readonly handle: WorkspaceHandle;
  readonly root: string;
  readonly #adapter: AgdaProtocolAdapter;
  readonly #queue: SerializedCommandQueue;
  readonly #goals = new GoalHandleTable();
  readonly #hostFactory: ProcessHostFactory;
  readonly #hostOptions: AgdaProcessHostOptions;
  #host: AgdaProcessHost;
  #lifecycle: WorkspaceSessionSummary["lifecycle"] = "starting";
  #revision = 0;
  #active: ActiveModuleState | undefined;
  #recoverable: ActiveModuleState | undefined;
  #terminating = false;

  constructor(options: WorkspaceSessionOptions) {
    this.handle = `workspace_${randomBytes(24).toString("base64url")}`;
    this.root = options.plan.projectRoot;
    this.#adapter = options.adapter;
    this.#queue = new SerializedCommandQueue(options.plan.commandPolicy.maxQueuedCommands);
    this.#hostFactory = options.processHostFactory ?? ((hostOptions) => new AgdaProcessHost(hostOptions));
    this.#hostOptions = {
      executable: options.plan.installation.executable,
      launchArguments: options.plan.launchArguments,
      cwd: options.plan.projectRoot,
      adapter: options.adapter,
      policy: options.plan.commandPolicy,
    };
    this.#host = this.#createHost();
  }

  get summary(): WorkspaceSessionSummary {
    const moduleState = this.#active ?? this.#recoverable;
    return Object.freeze({
      handle: this.handle,
      root: this.root,
      revision: this.#revision,
      lifecycle: this.#lifecycle,
      ...(moduleState === undefined ? {} : { activeModule: moduleState.plan.modulePath }),
    });
  }

  get activeResult(): NormalizedResult<ModuleCheckResult> | undefined {
    return this.#active?.result;
  }

  load(
    plan: ModuleDiscoveryPlan,
    signal?: AbortSignal,
  ): Promise<NormalizedResult<ModuleCheckResult>> {
    if (plan.projectRoot !== this.root) {
      return Promise.reject(
        new ApplicationError("UNKNOWN_WORKSPACE", "Module plan belongs to another workspace session"),
      );
    }
    return this.#queue.enqueue(() => this.#loadNow(plan, signal), signal);
  }

  typecheck(signal?: AbortSignal): Promise<NormalizedResult<ModuleCheckResult>> {
    return this.#queue.enqueue(async () => {
      const active = this.#active;
      if (active === undefined) {
        const recovered = await this.#recoverNow(signal);
        return recovered.result;
      }
      return this.#loadNow(active.plan, signal);
    }, signal);
  }

  resolveGoal(handle: string): GoalRecord {
    const active = this.#active;
    if (active === undefined) {
      throw new ApplicationError("STALE_GOAL_HANDLE", "Workspace has no active goal state");
    }
    return this.#goals.validate(handle, {
      workspace: this.handle,
      modulePath: active.plan.modulePath,
      revision: this.#revision,
      sourceFingerprint: active.snapshot.fingerprint,
      interactionPoints: active.interactionPoints,
    });
  }

  hasGoalHandle(handle: string): boolean {
    return this.#goals.has(handle);
  }

  goalHandle(interactionPoint: number): string | undefined {
    return this.#active?.goalHandles.get(interactionPoint);
  }

  async assertSourceUnchanged(): Promise<void> {
    const active = this.#active;
    if (active === undefined) throw new ApplicationError("NO_ACTIVE_MODULE", "Workspace has no active module");
    const current = await readSnapshot(active.plan.modulePath);
    if (current.fingerprint !== active.snapshot.fingerprint) {
      throw new ApplicationError("SOURCE_CHANGED", "The active Agda source changed on disk", {
        details: {
          modulePath: active.plan.modulePath,
          expectedSourceFingerprint: active.snapshot.fingerprint,
          actualSourceFingerprint: current.fingerprint,
        },
      });
    }
  }

  runCommand(
    command: AgdaCommand,
    options: SendCommandOptions = {},
  ): Promise<ProtocolCommandResult> {
    return this.#queue.enqueue(async () => {
      const active = await this.#activeNow(options.signal);
      await this.assertSourceUnchanged();
      return this.#host.sendCommand(
        command,
        { currentFile: active.plan.modulePath },
        sendOptions(options, active.plan.commandPolicy.queryTimeoutMs),
      );
    }, options.signal);
  }

  queryWorkspace(
    command: AgdaCommand,
    options: SendCommandOptions = {},
  ): Promise<SessionQueryState> {
    return this.#queue.enqueue(async () => {
      const active = await this.#activeNow(options.signal);
      await this.assertSourceUnchanged();
      const protocol = await this.#host.sendCommand(
        command,
        { currentFile: active.plan.modulePath },
        sendOptions(options, active.plan.commandPolicy.queryTimeoutMs),
      );
      return this.#queryState(active, protocol);
    }, options.signal);
  }

  queryGoal(
    handle: string,
    command: (goal: GoalRecord) => AgdaCommand,
    options: SendCommandOptions = {},
  ): Promise<GoalSessionQueryState> {
    return this.#queue.enqueue(async () => {
      const active = this.#active;
      if (active === undefined) throw new ApplicationError("STALE_GOAL_HANDLE", "Workspace has no active goal state");
      await this.assertSourceUnchanged();
      const goal = this.resolveGoal(handle);
      const protocol = await this.#host.sendCommand(
        command(goal),
        { currentFile: active.plan.modulePath },
        sendOptions(options, active.plan.commandPolicy.queryTimeoutMs),
      );
      return Object.freeze({ ...this.#queryState(active, protocol), goal });
    }, options.signal);
  }

  previewGoal<T>(
    handle: string,
    command: (goal: GoalRecord) => AgdaCommand,
    planner: (events: readonly unknown[], context: PreviewPlanningContext) => T,
    options: SendCommandOptions = {},
  ): Promise<PreviewTransactionResult<T>> {
    return this.#queue.enqueue(async () => {
      const active = this.#active;
      if (active === undefined) {
        throw new ApplicationError("STALE_GOAL_HANDLE", "Workspace has no active goal state");
      }
      await this.assertSourceUnchanged();
      const goal = this.resolveGoal(handle);
      let protocol: ProtocolCommandResult | undefined;
      let proposal: T | undefined;
      let operationError: unknown;
      let operationAttempted = false;

      try {
        operationAttempted = true;
        protocol = await this.#host.sendCommand(
          command(goal),
          { currentFile: active.plan.modulePath },
          sendOptions(options, active.plan.commandPolicy.transformationTimeoutMs),
        );
        const current = await readSnapshot(active.plan.modulePath);
        if (current.fingerprint !== active.snapshot.fingerprint) {
          throw sourceChangedError(active, current.fingerprint);
        }
        proposal = planner(
          protocol.raw.events,
          Object.freeze({
            modulePath: active.plan.modulePath,
            sourceFormat: active.plan.sourceFormat,
            source: active.snapshot.text,
            sourceFingerprint: active.snapshot.fingerprint,
            goalRange: goal.range,
          }),
        );
      } catch (error: unknown) {
        operationError = error;
      }

      let restored: NormalizedResult<ModuleCheckResult>;
      try {
        if (!operationAttempted) throw operationError;
        restored = await this.#loadNow(active.plan);
      } catch (restoreError: unknown) {
        this.#active = undefined;
        this.#recoverable = undefined;
        this.#goals.revokeAll();
        this.#lifecycle = "stopped";
        await this.#host.terminate().catch(() => undefined);
        throw new ApplicationError(
          "RESTORE_FAILED",
          "Agda state could not be restored after the transformation preview",
          {
            cause: restoreError,
            details: {
              modulePath: active.plan.modulePath,
              operationError: errorDescription(operationError),
              restoreError: errorDescription(restoreError),
            },
          },
        );
      }

      if (operationError !== undefined) throw operationError;
      if (protocol === undefined || proposal === undefined) {
        throw new ApplicationError(
          "UNSUPPORTED_AGDA_PROTOCOL",
          "Agda returned no transformation proposal",
        );
      }
      return Object.freeze({
        proposal,
        restored,
        raw: withRestoreTranscript(protocol.raw, restored.raw),
      });
    }, options.signal);
  }

  async terminate(): Promise<void> {
    this.#terminating = true;
    this.#queue.close();
    this.#goals.revokeAll();
    this.#active = undefined;
    this.#recoverable = undefined;
    this.#lifecycle = "stopped";
    await this.#host.terminate();
  }

  async #loadNow(
    plan: ModuleDiscoveryPlan,
    signal?: AbortSignal,
  ): Promise<NormalizedResult<ModuleCheckResult>> {
    this.#ensureHost();
    this.#lifecycle = this.#host.state === "new" ? "starting" : "ready";
    const snapshot = await readSnapshot(plan.modulePath);
    this.#goals.revokeAll();
    const context: AgdaCommandContext = { currentFile: plan.modulePath };
    const protocol = await this.#host.sendCommand(
      { kind: "load", modulePath: plan.modulePath, arguments: plan.load.arguments },
      context,
      {
        timeoutMs: plan.commandPolicy.loadTimeoutMs,
        ...(signal === undefined ? {} : { signal }),
      },
    );
    const normalized = normalizeLoadResponse(protocol.raw.events, snapshot.text, plan.modulePath);
    this.#revision += 1;
    const interactionPoints = new Set(normalized.goals.map((goal) => goal.interactionPoint));
    const goalHandles = new Map<number, string>();
    const goals: GoalSummary[] = normalized.goals.map((goal) => {
      const range = goal.range;
      const partial: Omit<GoalRecord, "protocolRange"> = {
        workspace: this.handle,
        modulePath: plan.modulePath,
        revision: this.#revision,
        sourceFingerprint: snapshot.fingerprint,
        interactionPoint: goal.interactionPoint,
        range,
      };
      const nativeRange = protocolRange(plan.modulePath, snapshot.text, range);
      const handle = this.#goals.issue({ ...partial, protocolRange: nativeRange });
      goalHandles.set(goal.interactionPoint, handle);
      return Object.freeze({
        handle,
        range,
        type: goal.type,
      });
    });
    const data: ModuleCheckResult = Object.freeze({
      workspace: this.handle,
      workspaceRoot: plan.workspaceRoot,
      projectRoot: plan.projectRoot,
      modulePath: plan.modulePath,
      sourceFormat: plan.sourceFormat,
      revision: this.#revision,
      sourceFingerprint: snapshot.fingerprint,
      checked: normalized.checked,
      diagnostics: normalized.diagnostics,
      goals: Object.freeze(goals),
      invisibleMetavariables: normalized.invisibleMetavariables,
      agda: versionInfo(plan.installation),
    });
    const result: NormalizedResult<ModuleCheckResult> = Object.freeze({
      data,
      warnings: Object.freeze([...plan.installation.warnings, ...normalized.warnings]),
      raw: protocol.raw,
    });
    this.#active = Object.freeze({
      plan,
      snapshot,
      interactionPoints,
      goalHandles,
      result,
    });
    this.#recoverable = undefined;
    this.#lifecycle = "ready";
    return result;
  }

  async #activeNow(signal?: AbortSignal): Promise<ActiveModuleState> {
    return this.#active ?? this.#recoverNow(signal);
  }

  async #recoverNow(signal?: AbortSignal): Promise<ActiveModuleState> {
    const recoverable = this.#recoverable;
    if (recoverable === undefined) {
      throw new ApplicationError("NO_ACTIVE_MODULE", "Workspace has no active module");
    }
    const current = await readSnapshot(recoverable.plan.modulePath);
    if (current.fingerprint !== recoverable.snapshot.fingerprint) {
      this.#recoverable = undefined;
      this.#lifecycle = "stopped";
      throw sourceChangedError(recoverable, current.fingerprint);
    }
    this.#ensureHost();
    await this.#loadNow(recoverable.plan, signal);
    return this.#active as ActiveModuleState;
  }

  #ensureHost(): void {
    if (this.#host.state !== "stopped") return;
    this.#host = this.#createHost();
    this.#lifecycle = this.#recoverable === undefined ? "starting" : "recovering";
  }

  #createHost(): AgdaProcessHost {
    const host = this.#hostFactory(this.#hostOptions);
    host.onExit(() => {
      if (this.#host !== host || this.#terminating) return;
      if (this.#active !== undefined) this.#recoverable = this.#active;
      this.#active = undefined;
      this.#goals.revokeAll();
      this.#lifecycle = this.#recoverable === undefined ? "stopped" : "recovering";
    });
    return host;
  }

  #queryState(active: ActiveModuleState, protocol: ProtocolCommandResult): SessionQueryState {
    return Object.freeze({
      workspace: this.handle,
      modulePath: active.plan.modulePath,
      revision: this.#revision,
      sourceFingerprint: active.snapshot.fingerprint,
      sourceText: active.snapshot.text,
      protocol,
    });
  }
}

function sendOptions(options: SendCommandOptions, timeoutMs: number): SendCommandOptions {
  return Object.freeze({
    timeoutMs: options.timeoutMs ?? timeoutMs,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}

function sourceChangedError(active: ActiveModuleState, actualFingerprint: string): ApplicationError {
  return new ApplicationError("SOURCE_CHANGED", "The active Agda source changed during the preview", {
    details: {
      modulePath: active.plan.modulePath,
      expectedSourceFingerprint: active.snapshot.fingerprint,
      actualSourceFingerprint: actualFingerprint,
    },
  });
}

function rawCommandTranscript(raw: RawAgdaResponse): RawCommandTranscript {
  return Object.freeze({
    events: raw.events,
    complete: raw.complete,
    capturedBytes: raw.capturedBytes,
    totalBytes: raw.totalBytes,
    omittedEventCount: raw.omittedEventCount,
    stderr: raw.stderr,
    ...(raw.omittedSha256 === undefined ? {} : { omittedSha256: raw.omittedSha256 }),
  });
}

function withRestoreTranscript(
  operation: RawAgdaResponse,
  restore: RawAgdaResponse,
): RawAgdaResponse {
  return Object.freeze({ ...operation, restore: rawCommandTranscript(restore) });
}

function errorDescription(error: unknown): string | undefined {
  if (error === undefined) return undefined;
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
