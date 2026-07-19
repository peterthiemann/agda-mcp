import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { ApplicationError } from "../application/errors.js";
import type {
  AgdaCommand,
  AgdaCommandContext,
  AgdaProtocolAdapter,
} from "./adapter.js";
import { InteractionJsonStreamParser, type InteractionJsonToken } from "./streamParser.js";
import { RawTranscriptCollector, type ProtocolCommandResult } from "./transcript.js";

export interface ProcessOutputPolicy {
  readonly commandTimeoutMs: number;
  readonly rawResponseLimitBytes: number;
  readonly stderrReturnLimitBytes: number;
  readonly maxCommandOutputBytes: number;
  readonly abortGraceMs?: number;
}

export interface AgdaProcessHostOptions {
  readonly executable: string;
  readonly launchArguments: readonly string[];
  readonly cwd: string;
  readonly adapter: AgdaProtocolAdapter;
  readonly policy: ProcessOutputPolicy;
}

export type ProcessSpawner = (
  executable: string,
  arguments_: readonly string[],
  options: {
    readonly cwd: string;
    readonly shell: false;
    readonly stdio: ["pipe", "pipe", "pipe"];
  },
) => ChildProcessWithoutNullStreams;

export interface AgdaProcessHostDependencies {
  readonly spawnProcess?: ProcessSpawner;
}

export interface SendCommandOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface ProcessExitInfo {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly error?: unknown;
}

type HostState = "new" | "starting" | "ready" | "stopping" | "stopped";

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

interface ActiveCommand {
  readonly collector: RawTranscriptCollector;
  readonly deferred: Deferred<ProtocolCommandResult>;
  readonly context: AgdaCommandContext;
  readonly signal?: AbortSignal;
  signalListener?: () => void;
  timeout: ReturnType<typeof setTimeout> | undefined;
  abortGrace: ReturnType<typeof setTimeout> | undefined;
  abortDeferred: Deferred<void> | undefined;
  terminalError: ApplicationError | undefined;
  outputBytes: number;
  abortSent: boolean;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

export class AgdaProcessHost {
  readonly #options: AgdaProcessHostOptions;
  readonly #spawnProcess: ProcessSpawner;
  readonly #parser = new InteractionJsonStreamParser();
  readonly #exitListeners = new Set<(info: ProcessExitInfo) => void>();
  #state: HostState = "new";
  #child: ChildProcessWithoutNullStreams | undefined;
  #startDeferred: Deferred<void> | undefined;
  #startTimeout: ReturnType<typeof setTimeout> | undefined;
  #active: ActiveCommand | undefined;
  #exitDeferred: Deferred<ProcessExitInfo> | undefined;
  #exitInfo: ProcessExitInfo | undefined;
  #startupOutputBytes = 0;

  constructor(options: AgdaProcessHostOptions, dependencies: AgdaProcessHostDependencies = {}) {
    this.#options = options;
    this.#spawnProcess = dependencies.spawnProcess ?? ((executable, arguments_, spawnOptions) =>
      spawn(executable, [...arguments_], spawnOptions));
  }

  get state(): HostState {
    return this.#state;
  }

  get pid(): number | undefined {
    return this.#child?.pid;
  }

  async start(): Promise<void> {
    if (this.#state === "ready") return;
    if (this.#state === "starting") return this.#startDeferred?.promise;
    if (this.#state !== "new") {
      throw new ApplicationError("PROCESS_EXITED", "Agda process host cannot be restarted");
    }

    this.#state = "starting";
    this.#startDeferred = deferred<void>();
    this.#exitDeferred = deferred<ProcessExitInfo>();
    try {
      this.#child = this.#spawnProcess(this.#options.executable, this.#options.launchArguments, {
        cwd: this.#options.cwd,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error: unknown) {
      this.#handleExit({ code: null, signal: null, error });
      throw new ApplicationError("PROCESS_EXITED", "Failed to spawn Agda", { cause: error });
    }

    this.#child.stdout.on("data", (chunk: Buffer) => this.#handleStdout(chunk));
    this.#child.stderr.on("data", (chunk: Buffer) => this.#handleStderr(chunk));
    this.#child.once("error", (error) => this.#handleExit({ code: null, signal: null, error }));
    this.#child.once("exit", (code, signal) => this.#handleExit({ code, signal }));

    this.#startTimeout = setTimeout(() => {
      const error = new ApplicationError("COMMAND_TIMEOUT", "Timed out waiting for Agda's initial JSON prompt");
      this.#startDeferred?.reject(error);
      void this.terminate();
    }, this.#options.policy.commandTimeoutMs);
    this.#startTimeout.unref();
    return this.#startDeferred.promise;
  }

  async sendCommand(
    command: AgdaCommand,
    context: AgdaCommandContext,
    options: SendCommandOptions = {},
  ): Promise<ProtocolCommandResult> {
    await this.start();
    if (this.#state !== "ready" || this.#child === undefined) {
      throw new ApplicationError("PROCESS_EXITED", "Agda process is not ready");
    }
    if (this.#active !== undefined) {
      throw new ApplicationError("AGDA_COMMAND_REJECTED", "Another Agda command is already active");
    }
    if (options.signal?.aborted === true) {
      throw new ApplicationError("AGDA_COMMAND_REJECTED", "Agda command was cancelled before it started", {
        details: { cancelled: true },
      });
    }

    const active: ActiveCommand = {
      collector: new RawTranscriptCollector(
        this.#options.adapter.id,
        this.#options.policy.rawResponseLimitBytes,
        this.#options.policy.stderrReturnLimitBytes,
      ),
      deferred: deferred<ProtocolCommandResult>(),
      context,
      timeout: undefined,
      abortGrace: undefined,
      abortDeferred: undefined,
      terminalError: undefined,
      outputBytes: 0,
      abortSent: false,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    };
    const timeoutMs = options.timeoutMs ?? this.#options.policy.commandTimeoutMs;
    active.timeout = setTimeout(() => {
      active.terminalError = new ApplicationError("COMMAND_TIMEOUT", `Agda command exceeded ${timeoutMs} ms`, {
        details: { timeoutMs },
      });
      void this.#requestAbort(active).catch(() => undefined);
    }, timeoutMs);
    active.timeout.unref();
    if (options.signal !== undefined) {
      const listener = (): void => {
        active.terminalError ??= new ApplicationError("AGDA_COMMAND_REJECTED", "Agda command was cancelled", {
          details: { cancelled: true },
        });
        void this.#requestAbort(active).catch(() => undefined);
      };
      active.signalListener = listener;
      options.signal.addEventListener("abort", listener, { once: true });
    }
    this.#active = active;

    const encoded = this.#options.adapter.encodeCommand(command, context);
    this.#child.stdin.write(encoded, "utf8", (error) => {
      if (error !== null && error !== undefined) {
        this.#failActive(
          new ApplicationError("PROCESS_EXITED", "Failed to write an Agda command", { cause: error }),
        );
      }
    });
    return active.deferred.promise;
  }

  async abort(context?: AgdaCommandContext): Promise<void> {
    const active = this.#active;
    if (active === undefined) return;
    active.terminalError ??= new ApplicationError("AGDA_COMMAND_REJECTED", "Agda command was aborted", {
      details: { cancelled: true },
    });
    if (context !== undefined && context.currentFile !== active.context.currentFile) {
      throw new ApplicationError("INVALID_ARGUMENT", "Abort context does not match the active command");
    }
    await this.#requestAbort(active);
  }

  async terminate(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    if (this.#state === "stopped") return;
    const child = this.#child;
    if (child === undefined) {
      this.#state = "stopped";
      return;
    }
    this.#state = "stopping";
    child.kill(signal);
    await this.#exitDeferred?.promise;
  }

  onExit(listener: (info: ProcessExitInfo) => void): () => void {
    this.#exitListeners.add(listener);
    if (this.#exitInfo !== undefined) queueMicrotask(() => listener(this.#exitInfo as ProcessExitInfo));
    return () => this.#exitListeners.delete(listener);
  }

  async #requestAbort(active: ActiveCommand): Promise<void> {
    if (this.#active !== active) return;
    active.abortDeferred ??= deferred<void>();
    if (!active.abortSent && this.#child !== undefined) {
      active.abortSent = true;
      const encoded = this.#options.adapter.encodeCommand({ kind: "abort" }, active.context);
      this.#child.stdin.write(encoded, "utf8");
      const graceMs = this.#options.policy.abortGraceMs ?? 1_000;
      active.abortGrace = setTimeout(() => void this.terminate(), graceMs);
      active.abortGrace.unref();
    }
    return active.abortDeferred.promise;
  }

  #handleStdout(chunk: Buffer): void {
    if (!this.#accountOutput(chunk.length)) return;
    let tokens: readonly InteractionJsonToken[];
    try {
      tokens = this.#parser.feed(chunk);
    } catch (error: unknown) {
      const protocolError =
        error instanceof ApplicationError
          ? error
          : new ApplicationError("UNSUPPORTED_AGDA_PROTOCOL", "Failed to parse Agda stdout", {
              cause: error,
            });
      this.#failActive(protocolError);
      void this.terminate();
      return;
    }
    try {
      for (const token of tokens) this.#handleToken(token);
    } catch (error: unknown) {
      const protocolError =
        error instanceof ApplicationError
          ? error
          : new ApplicationError("UNSUPPORTED_AGDA_PROTOCOL", "Failed to decode an Agda event", {
              cause: error,
            });
      this.#failActive(protocolError);
      void this.terminate();
    }
  }

  #handleStderr(chunk: Buffer): void {
    if (!this.#accountOutput(chunk.length)) return;
    this.#active?.collector.addStderr(chunk);
  }

  #accountOutput(bytes: number): boolean {
    const active = this.#active;
    if (active === undefined) {
      if (this.#state === "starting") {
        this.#startupOutputBytes += bytes;
        if (this.#startupOutputBytes > this.#options.policy.maxCommandOutputBytes) {
          const error = new ApplicationError("OUTPUT_LIMIT_EXCEEDED", "Agda startup output exceeded the hard limit");
          this.#startDeferred?.reject(error);
          void this.terminate();
          return false;
        }
      }
      return true;
    }
    active.outputBytes += bytes;
    if (active.outputBytes <= this.#options.policy.maxCommandOutputBytes) return true;
    active.terminalError = new ApplicationError(
      "OUTPUT_LIMIT_EXCEEDED",
      "Agda command output exceeded the hard limit",
      { details: { maxCommandOutputBytes: this.#options.policy.maxCommandOutputBytes } },
    );
    this.#failActive(active.terminalError);
    void this.terminate();
    return false;
  }

  #handleToken(token: InteractionJsonToken): void {
    if (token.kind === "prompt") {
      if (this.#state === "starting") {
        if (this.#startTimeout !== undefined) clearTimeout(this.#startTimeout);
        this.#startTimeout = undefined;
        this.#state = "ready";
        this.#startDeferred?.resolve();
        return;
      }
      const active = this.#active;
      if (active !== undefined) this.#completeActive(active);
      return;
    }

    const active = this.#active;
    if (active === undefined) return;
    if (token.kind === "stdout") {
      active.collector.addStdoutFragment(token.text);
      return;
    }
    const event = this.#options.adapter.decodeEvent(token.value);
    active.collector.addEvent(event, token.raw);
  }

  #completeActive(active: ActiveCommand): void {
    if (this.#active !== active) return;
    this.#clearActiveTimers(active);
    this.#active = undefined;
    active.abortDeferred?.resolve();
    const result = active.collector.finish();
    if (active.terminalError !== undefined) {
      active.deferred.reject(active.terminalError);
    } else if (result.stdoutFragments.some((fragment) => fragment.trimStart().startsWith("cannot read:"))) {
      active.deferred.reject(
        new ApplicationError("AGDA_COMMAND_REJECTED", "Agda could not parse the interaction command", {
          details: {
            stdoutFragments: result.stdoutFragments,
            raw: result.raw,
          },
        }),
      );
    } else {
      active.deferred.resolve(result);
    }
  }

  #failActive(error: ApplicationError): void {
    const active = this.#active;
    if (active === undefined) return;
    this.#clearActiveTimers(active);
    this.#active = undefined;
    active.abortDeferred?.reject(error);
    active.deferred.reject(active.terminalError ?? error);
  }

  #clearActiveTimers(active: ActiveCommand): void {
    if (active.timeout !== undefined) clearTimeout(active.timeout);
    if (active.abortGrace !== undefined) clearTimeout(active.abortGrace);
    if (active.signal !== undefined && active.signalListener !== undefined) {
      active.signal.removeEventListener("abort", active.signalListener);
    }
  }

  #handleExit(info: ProcessExitInfo): void {
    if (this.#exitInfo !== undefined) return;
    this.#exitInfo = Object.freeze(info);
    if (this.#startTimeout !== undefined) clearTimeout(this.#startTimeout);
    this.#startTimeout = undefined;
    this.#state = "stopped";
    const error = new ApplicationError("PROCESS_EXITED", "Agda process exited unexpectedly", {
      details: { code: info.code, signal: info.signal },
      ...(info.error === undefined ? {} : { cause: info.error }),
    });
    this.#startDeferred?.reject(error);
    this.#failActive(error);
    this.#exitDeferred?.resolve(this.#exitInfo);
    for (const listener of this.#exitListeners) listener(this.#exitInfo);
  }
}
