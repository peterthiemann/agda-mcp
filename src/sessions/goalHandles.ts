import { randomBytes } from "node:crypto";

import { DEFAULT_HANDLE_ENTROPY_BYTES } from "../application/config.js";
import type { GoalHandle, SourceRange, WorkspaceHandle } from "../application/domain.js";
import { ApplicationError } from "../application/errors.js";
import type { AgdaProtocolRange } from "../protocol/adapter.js";

export interface GoalRecord {
  readonly workspace: WorkspaceHandle;
  readonly modulePath: string;
  readonly revision: number;
  /**
   * The load generation the handle was issued under. A generation covers one
   * observable Agda state and advances on every reload, so any load,
   * typecheck, module switch, recovery or preview restore revokes it.
   */
  readonly generation: number;
  readonly sourceFingerprint: string;
  readonly interactionPoint: number;
  readonly range: SourceRange;
  readonly protocolRange: AgdaProtocolRange;
}

export interface CurrentGoalState {
  readonly workspace: WorkspaceHandle;
  readonly modulePath: string;
  readonly generation: number;
  readonly sourceFingerprint: string;
  readonly interactionPoints: ReadonlySet<number>;
}

export class GoalHandleTable {
  readonly #records = new Map<GoalHandle, GoalRecord>();
  readonly #entropyBytes: number;

  constructor(entropyBytes: number = DEFAULT_HANDLE_ENTROPY_BYTES) {
    this.#entropyBytes = entropyBytes;
  }

  get size(): number {
    return this.#records.size;
  }

  /**
   * Handles are unguessable random tokens, never derived from goal content: a
   * derived handle could be reconstructed after the table had deliberately
   * dropped it, letting a handle come back to life after switching away from
   * and back to a module.
   */
  issue(record: GoalRecord): GoalHandle {
    let handle: GoalHandle;
    do {
      handle = `goal_${randomBytes(this.#entropyBytes).toString("base64url")}`;
    } while (this.#records.has(handle));
    this.#records.set(handle, Object.freeze({ ...record }));
    return handle;
  }

  validate(handle: GoalHandle, current: CurrentGoalState): GoalRecord {
    const record = this.#records.get(handle);
    if (
      record === undefined ||
      record.workspace !== current.workspace ||
      record.modulePath !== current.modulePath ||
      record.generation !== current.generation ||
      record.sourceFingerprint !== current.sourceFingerprint ||
      !current.interactionPoints.has(record.interactionPoint)
    ) {
      throw new ApplicationError("STALE_GOAL_HANDLE", "Goal handle is stale or belongs to another workspace", {
        details: { goal: handle },
      });
    }
    return record;
  }

  has(handle: GoalHandle): boolean {
    return this.#records.has(handle);
  }

  revokeAll(): void {
    this.#records.clear();
  }
}
