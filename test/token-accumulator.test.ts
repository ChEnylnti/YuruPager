import assert from "node:assert/strict";
import { test } from "node:test";

import type { ThreadTokenUsage } from "../src/codex/domain.js";
import { TokenUsageAccumulator } from "../src/reliability/token-accumulator.js";

test("replaces cumulative snapshots instead of summing totals", () => {
  const accumulator = new TokenUsageAccumulator();
  accumulator.ingest(snapshot("event-1", 1, usage(100, 20)));
  const result = accumulator.ingest(snapshot("event-2", 2, usage(150, 35)));

  assert.equal(result.state.total.totalTokens, 185);
  assert.equal(result.delta.totalTokens, 65);
});

test("deduplicates replayed events and ignores out-of-order snapshots", () => {
  const accumulator = new TokenUsageAccumulator();
  const first = snapshot("event-1", 4, usage(100, 20));
  accumulator.ingest(first);

  assert.equal(accumulator.ingest(first).duplicate, true);
  assert.equal(
    accumulator.ingest(snapshot("event-old", 3, usage(80, 10))).outOfOrder,
    true,
  );
  assert.equal(accumulator.get("thread-1")?.total.totalTokens, 120);
});

test("marks a counter reset as incomplete", () => {
  const accumulator = new TokenUsageAccumulator();
  accumulator.ingest(snapshot("event-1", 1, usage(100, 20)));
  const reset = accumulator.ingest(snapshot("event-2", 2, usage(10, 5)));

  assert.equal(reset.state.quality, "incomplete");
  assert.equal(reset.state.resetDetected, true);
  assert.equal(reset.delta.totalTokens, 0);
});

test("finalizes usage only for the matching turn", () => {
  const accumulator = new TokenUsageAccumulator();
  accumulator.ingest(snapshot("event-1", 1, usage(100, 20)));

  assert.equal(accumulator.finalizeTurn("thread-1", "turn-1").quality, "final");
  assert.equal(
    accumulator.finalizeTurn("thread-1", "another-turn").quality,
    "incomplete",
  );
});

function snapshot(
  eventId: string,
  sequence: number,
  tokenUsage: ThreadTokenUsage,
) {
  return {
    eventId,
    sequence,
    threadId: "thread-1",
    turnId: "turn-1",
    usage: tokenUsage,
    observedAt: "2026-08-03T00:00:00.000Z",
  };
}

function usage(inputTokens: number, outputTokens: number): ThreadTokenUsage {
  return {
    last: {
      inputTokens,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens,
      reasoningOutputTokens: 0,
      totalTokens: inputTokens + outputTokens,
    },
    total: {
      inputTokens,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens,
      reasoningOutputTokens: 0,
      totalTokens: inputTokens + outputTokens,
    },
    modelContextWindow: 200_000,
  };
}

