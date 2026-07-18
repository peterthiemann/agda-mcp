export const APPLICATION_ERROR_CODES = [
  "INVALID_ARGUMENT",
  "PATH_OUTSIDE_WORKSPACE",
  "AGDA_NOT_FOUND",
  "NO_ACTIVE_MODULE",
  "UNKNOWN_WORKSPACE",
  "STALE_GOAL_HANDLE",
  "SOURCE_CHANGED",
  "UNSUPPORTED_EDIT_SHAPE",
  "AGDA_COMMAND_REJECTED",
  "UNSUPPORTED_AGDA_PROTOCOL",
  "COMMAND_TIMEOUT",
  "PROCESS_EXITED",
  "OUTPUT_LIMIT_EXCEEDED",
  "RESTORE_FAILED",
] as const;

export type ApplicationErrorCode = (typeof APPLICATION_ERROR_CODES)[number];

export interface ApplicationErrorOptions {
  readonly recoverable?: boolean;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
}

const DEFAULT_RECOVERABILITY: Readonly<Record<ApplicationErrorCode, boolean>> = {
  INVALID_ARGUMENT: true,
  PATH_OUTSIDE_WORKSPACE: true,
  AGDA_NOT_FOUND: true,
  NO_ACTIVE_MODULE: true,
  UNKNOWN_WORKSPACE: true,
  STALE_GOAL_HANDLE: true,
  SOURCE_CHANGED: true,
  UNSUPPORTED_EDIT_SHAPE: false,
  AGDA_COMMAND_REJECTED: true,
  UNSUPPORTED_AGDA_PROTOCOL: false,
  COMMAND_TIMEOUT: true,
  PROCESS_EXITED: true,
  OUTPUT_LIMIT_EXCEEDED: true,
  RESTORE_FAILED: true,
};

export class ApplicationError extends Error {
  readonly code: ApplicationErrorCode;
  readonly recoverable: boolean;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: ApplicationErrorCode, message: string, options: ApplicationErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ApplicationError";
    this.code = code;
    this.recoverable = options.recoverable ?? DEFAULT_RECOVERABILITY[code];
    this.details = Object.freeze({ ...(options.details ?? {}) });
  }
}

export function isApplicationError(error: unknown): error is ApplicationError {
  return error instanceof ApplicationError;
}
