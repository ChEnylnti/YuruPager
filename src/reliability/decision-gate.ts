import { createHash } from "node:crypto";

import type { ApprovalDecision } from "../codex/domain.js";

export interface DecisionRecord {
  requestId: string;
  idempotencyKey: string;
  decision: ApprovalDecision;
  decidedAt: string;
}

export interface DecisionResult {
  accepted: boolean;
  replayed: boolean;
  record: DecisionRecord;
}

export class DecisionConflictError extends Error {
  override readonly name = "DecisionConflictError";

  constructor(
    message: string,
    readonly existing: DecisionRecord,
  ) {
    super(message);
  }
}

export class InMemoryDecisionGate {
  readonly #byRequest = new Map<string, DecisionRecord>();
  readonly #keyBindings = new Map<string, string>();
  readonly #now: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.#now = now;
  }

  decide(
    requestId: string,
    idempotencyKey: string,
    decision: ApprovalDecision,
  ): DecisionResult {
    if (requestId.length === 0 || idempotencyKey.length === 0) {
      throw new Error("requestId and idempotencyKey are required");
    }

    const keyFingerprint = decisionFingerprint(requestId, decision);
    const boundFingerprint = this.#keyBindings.get(idempotencyKey);
    const existing = this.#byRequest.get(requestId);

    if (existing !== undefined) {
      if (
        existing.idempotencyKey === idempotencyKey &&
        boundFingerprint === keyFingerprint &&
        existing.decision === decision
      ) {
        return { accepted: true, replayed: true, record: existing };
      }
      throw new DecisionConflictError(
        "Approval request already has a final decision",
        existing,
      );
    }

    if (boundFingerprint !== undefined && boundFingerprint !== keyFingerprint) {
      throw new Error("Idempotency key is already bound to another payload");
    }

    const record: DecisionRecord = Object.freeze({
      requestId,
      idempotencyKey,
      decision,
      decidedAt: this.#now().toISOString(),
    });
    this.#keyBindings.set(idempotencyKey, keyFingerprint);
    this.#byRequest.set(requestId, record);
    return { accepted: true, replayed: false, record };
  }

  get(requestId: string): DecisionRecord | undefined {
    return this.#byRequest.get(requestId);
  }
}

export function decisionFingerprint(
  requestId: string,
  decision: ApprovalDecision,
): string {
  return createHash("sha256")
    .update(`${requestId}\u0000${decision}`)
    .digest("hex");
}
