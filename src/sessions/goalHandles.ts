import { createHmac, randomBytes } from "node:crypto";

import { DEFAULT_HANDLE_ENTROPY_BYTES } from "../application/config.js";
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
  readonly #secret: Buffer;
  readonly #digestBytes: number;

  constructor(entropyBytes: number = DEFAULT_HANDLE_ENTROPY_BYTES) {
    // A per-session secret keeps deterministic handles unguessable from outside.
    this.#secret = randomBytes(entropyBytes);
    this.#digestBytes = entropyBytes;
  }

  get size(): number {
    return this.#records.size;
  }

  /**
   * Handles are derived from the goal's identity rather than drawn at random,
   * so reloading unchanged source reissues byte-identical handles. That keeps
   * a caller's handles alive across the reload that case split, refine, and
   * auto perform internally, and across a no-op typecheck.
   *
   * The source fingerprint is part of the identity on purpose: once the file
   * changes, Agda may renumber interaction points, so yesterday's handle must
   * NOT silently resolve to a different hole.
   */
  issue(record: GoalRecord): GoalHandle {
    // The NUL separator cannot occur in a path or a hex fingerprint, so the
    // joined parts can never be confused for one another.
    const digest = createHmac("sha256", this.#secret)
      .update(
        [
          record.workspace,
          record.modulePath,
          record.sourceFingerprint,
          String(record.interactionPoint),
        ].join("\u0000"),
      )
      .digest()
      .subarray(0, this.#digestBytes)
      .toString("base64url");
    const handle: GoalHandle = `goal_${digest}`;
    this.#records.set(handle, Object.freeze({ ...record }));
    return handle;
  }

  validate(handle: GoalHandle, current: CurrentGoalState): GoalRecord {
    const record = this.#records.get(handle);
    if (
      record === undefined ||
      record.workspace !== current.workspace ||
      record.modulePath !== current.modulePath ||
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
