import { randomBytes } from "node:crypto";

import type { GoalHandle, SourceRange, WorkspaceHandle } from "../application/domain.js";
import { ApplicationError } from "../application/errors.js";
import type { AgdaProtocolRange } from "../protocol/adapter.js";

export interface GoalRecord {
  readonly workspace: WorkspaceHandle;
  readonly modulePath: string;
  readonly revision: number;
  readonly sourceFingerprint: string;
  readonly interactionPoint: number;
  readonly range: SourceRange;
  readonly protocolRange: AgdaProtocolRange;
}

export interface CurrentGoalState {
  readonly workspace: WorkspaceHandle;
  readonly modulePath: string;
  readonly revision: number;
  readonly sourceFingerprint: string;
  readonly interactionPoints: ReadonlySet<number>;
}

export class GoalHandleTable {
  readonly #records = new Map<GoalHandle, GoalRecord>();

  get size(): number {
    return this.#records.size;
  }

  issue(record: GoalRecord): GoalHandle {
    let handle: GoalHandle;
    do {
      handle = `goal_${randomBytes(24).toString("base64url")}`;
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
      record.revision !== current.revision ||
      record.sourceFingerprint !== current.sourceFingerprint ||
      !current.interactionPoints.has(record.interactionPoint)
    ) {
      throw new ApplicationError("STALE_GOAL_HANDLE", "Goal handle is stale or belongs to another workspace", {
        details: { goal: handle },
      });
    }
    return record;
  }

  revokeAll(): void {
    this.#records.clear();
  }
}
