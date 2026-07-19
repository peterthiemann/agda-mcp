import { ApplicationError } from "../application/errors.js";

interface QueueEntry<T> {
  readonly operation: () => Promise<T>;
  readonly signal?: AbortSignal;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
  cancelled: boolean;
  abortListener?: () => void;
}

export class SerializedCommandQueue {
  readonly #entries: QueueEntry<unknown>[] = [];
  #running = false;
  #closed = false;

  constructor(readonly maxPending: number = 64) {
    if (!Number.isSafeInteger(maxPending) || maxPending <= 0) {
      throw new ApplicationError("INVALID_ARGUMENT", "maxPending must be a positive safe integer");
    }
  }

  get pending(): number {
    return this.#entries.length + (this.#running ? 1 : 0);
  }

  enqueue<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.#closed) {
      return Promise.reject(
        new ApplicationError("PROCESS_EXITED", "The workspace command queue is closed"),
      );
    }
    if (signal?.aborted === true) {
      return Promise.reject(cancelledBeforeStart());
    }
    if (this.pending >= this.maxPending) {
      return Promise.reject(
        new ApplicationError("AGDA_COMMAND_REJECTED", "Workspace command queue is full", {
          details: { queueFull: true, maxPending: this.maxPending },
        }),
      );
    }

    return new Promise<T>((resolve, reject) => {
      const entry: QueueEntry<T> = {
        operation,
        resolve,
        reject,
        cancelled: false,
        ...(signal === undefined ? {} : { signal }),
      };
      if (signal !== undefined) {
        const listener = (): void => {
          entry.cancelled = true;
        };
        entry.abortListener = listener;
        signal.addEventListener("abort", listener, { once: true });
      }
      this.#entries.push(entry as QueueEntry<unknown>);
      void this.#drain();
    });
  }

  close(reason: ApplicationError = new ApplicationError("PROCESS_EXITED", "Queue closed")): void {
    this.#closed = true;
    for (const entry of this.#entries.splice(0)) {
      this.#removeAbortListener(entry);
      entry.reject(reason);
    }
  }

  async #drain(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      while (this.#entries.length > 0) {
        const entry = this.#entries.shift() as QueueEntry<unknown>;
        this.#removeAbortListener(entry);
        if (entry.cancelled || entry.signal?.aborted === true) {
          entry.reject(cancelledBeforeStart());
          continue;
        }
        try {
          entry.resolve(await entry.operation());
        } catch (error: unknown) {
          entry.reject(error);
        }
      }
    } finally {
      this.#running = false;
      if (this.#entries.length > 0) void this.#drain();
    }
  }

  #removeAbortListener(entry: QueueEntry<unknown>): void {
    if (entry.signal !== undefined && entry.abortListener !== undefined) {
      entry.signal.removeEventListener("abort", entry.abortListener);
    }
  }
}

function cancelledBeforeStart(): ApplicationError {
  return new ApplicationError("AGDA_COMMAND_REJECTED", "Command was cancelled before it started", {
    details: { cancelled: true, queued: true },
  });
}
