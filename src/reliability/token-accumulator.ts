import type {
  ThreadTokenUsage,
  TokenUsageBreakdown,
} from "../codex/domain.js";

export interface UsageSnapshot {
  eventId: string;
  sequence: number;
  threadId: string;
  turnId: string;
  usage: ThreadTokenUsage;
  observedAt: string;
}

export type UsageQuality = "provisional" | "final" | "incomplete";

export interface ThreadUsageState {
  threadId: string;
  latestTurnId: string;
  latestSequence: number;
  latestEventId: string;
  observedAt: string;
  total: TokenUsageBreakdown;
  last: TokenUsageBreakdown;
  quality: UsageQuality;
  resetDetected: boolean;
}

export interface IngestResult {
  accepted: boolean;
  duplicate: boolean;
  outOfOrder: boolean;
  delta: TokenUsageBreakdown;
  state: ThreadUsageState;
}

export class TokenUsageAccumulator {
  readonly #seenEvents = new Set<string>();
  readonly #threads = new Map<string, ThreadUsageState>();

  ingest(snapshot: UsageSnapshot): IngestResult {
    validateSnapshot(snapshot);
    const previous = this.#threads.get(snapshot.threadId);

    if (this.#seenEvents.has(snapshot.eventId)) {
      if (previous === undefined) {
        throw new Error("Seen event has no corresponding thread state");
      }
      return {
        accepted: false,
        duplicate: true,
        outOfOrder: false,
        delta: zeroUsage(),
        state: previous,
      };
    }
    this.#seenEvents.add(snapshot.eventId);

    if (previous !== undefined && snapshot.sequence <= previous.latestSequence) {
      return {
        accepted: false,
        duplicate: false,
        outOfOrder: true,
        delta: zeroUsage(),
        state: previous,
      };
    }

    const resetDetected =
      previous !== undefined && hasCounterDecrease(previous.total, snapshot.usage.total);
    const quality: UsageQuality = resetDetected ? "incomplete" : "provisional";
    const state: ThreadUsageState = Object.freeze({
      threadId: snapshot.threadId,
      latestTurnId: snapshot.turnId,
      latestSequence: snapshot.sequence,
      latestEventId: snapshot.eventId,
      observedAt: snapshot.observedAt,
      total: Object.freeze({ ...snapshot.usage.total }),
      last: Object.freeze({ ...snapshot.usage.last }),
      quality,
      resetDetected,
    });
    this.#threads.set(snapshot.threadId, state);

    return {
      accepted: true,
      duplicate: false,
      outOfOrder: false,
      delta:
        previous === undefined || resetDetected
          ? zeroUsage()
          : subtractUsage(snapshot.usage.total, previous.total),
      state,
    };
  }

  finalizeTurn(threadId: string, turnId: string): ThreadUsageState {
    const current = this.#threads.get(threadId);
    if (current === undefined) {
      throw new Error(`No token usage received for thread: ${threadId}`);
    }
    const state: ThreadUsageState = Object.freeze({
      ...current,
      quality:
        current.latestTurnId === turnId && !current.resetDetected
          ? "final"
          : "incomplete",
    });
    this.#threads.set(threadId, state);
    return state;
  }

  get(threadId: string): ThreadUsageState | undefined {
    return this.#threads.get(threadId);
  }
}

function validateSnapshot(snapshot: UsageSnapshot): void {
  if (snapshot.eventId.length === 0 || snapshot.threadId.length === 0) {
    throw new Error("Usage snapshot identifiers are required");
  }
  if (!Number.isSafeInteger(snapshot.sequence) || snapshot.sequence < 0) {
    throw new Error("Usage sequence must be a non-negative safe integer");
  }
  validateUsage(snapshot.usage.last);
  validateUsage(snapshot.usage.total);
}

function validateUsage(usage: TokenUsageBreakdown): void {
  for (const value of Object.values(usage)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("Token counters must be non-negative safe integers");
    }
  }
}

function hasCounterDecrease(
  previous: TokenUsageBreakdown,
  next: TokenUsageBreakdown,
): boolean {
  return (Object.keys(previous) as Array<keyof TokenUsageBreakdown>).some(
    (key) => next[key] < previous[key],
  );
}

function subtractUsage(
  next: TokenUsageBreakdown,
  previous: TokenUsageBreakdown,
): TokenUsageBreakdown {
  return {
    inputTokens: next.inputTokens - previous.inputTokens,
    cachedInputTokens: next.cachedInputTokens - previous.cachedInputTokens,
    cacheWriteInputTokens:
      next.cacheWriteInputTokens - previous.cacheWriteInputTokens,
    outputTokens: next.outputTokens - previous.outputTokens,
    reasoningOutputTokens:
      next.reasoningOutputTokens - previous.reasoningOutputTokens,
    totalTokens: next.totalTokens - previous.totalTokens,
  };
}

function zeroUsage(): TokenUsageBreakdown {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
  };
}

