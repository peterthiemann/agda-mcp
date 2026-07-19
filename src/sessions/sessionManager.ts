import type {
  ModuleCheckResult,
  NormalizedResult,
  WorkspaceHandle,
  WorkspaceSessionSummary,
} from "../application/domain.js";
import type { ResolvedServerOptions } from "../application/config.js";
import { ApplicationError } from "../application/errors.js";
import type { AgdaInstallation } from "../discovery/agdaInstallation.js";
import { discoverModulePlan } from "../discovery/projectResolver.js";
import type { AgdaProtocolAdapter } from "../protocol/adapter.js";
import {
  WorkspaceSession,
  type ProcessHostFactory,
} from "./workspaceSession.js";

export interface WorkspaceSessionManagerOptions {
  readonly serverOptions: ResolvedServerOptions;
  readonly installation: AgdaInstallation;
  readonly adapter: AgdaProtocolAdapter;
  readonly processHostFactory?: ProcessHostFactory;
}

export class WorkspaceSessionManager {
  readonly #options: WorkspaceSessionManagerOptions;
  readonly #byRoot = new Map<string, WorkspaceSession>();
  readonly #byHandle = new Map<WorkspaceHandle, WorkspaceSession>();

  constructor(options: WorkspaceSessionManagerOptions) {
    this.#options = options;
  }

  get summaries(): readonly WorkspaceSessionSummary[] {
    return Object.freeze(
      [...this.#byRoot.values()]
        .map((session) => session.summary)
        .sort((left, right) => left.root.localeCompare(right.root)),
    );
  }

  async loadModule(
    modulePath: string,
    signal?: AbortSignal,
  ): Promise<NormalizedResult<ModuleCheckResult>> {
    const plan = await discoverModulePlan(
      modulePath,
      this.#options.serverOptions,
      this.#options.installation,
    );
    let session = this.#byRoot.get(plan.projectRoot);
    if (session === undefined) {
      session = new WorkspaceSession({
        plan,
        adapter: this.#options.adapter,
        ...(this.#options.processHostFactory === undefined
          ? {}
          : { processHostFactory: this.#options.processHostFactory }),
      });
      this.#byRoot.set(plan.projectRoot, session);
      this.#byHandle.set(session.handle, session);
    }
    return session.load(plan, signal);
  }

  typecheck(
    workspace: WorkspaceHandle,
    signal?: AbortSignal,
  ): Promise<NormalizedResult<ModuleCheckResult>> {
    return this.require(workspace).typecheck(signal);
  }

  require(workspace: WorkspaceHandle): WorkspaceSession {
    const session = this.#byHandle.get(workspace);
    if (session === undefined) {
      throw new ApplicationError("UNKNOWN_WORKSPACE", "Unknown workspace handle", {
        details: { workspace },
      });
    }
    return session;
  }

  async terminate(): Promise<void> {
    await Promise.all([...this.#byRoot.values()].map((session) => session.terminate()));
    this.#byRoot.clear();
    this.#byHandle.clear();
  }
}
