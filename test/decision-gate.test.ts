import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DecisionConflictError,
  InMemoryDecisionGate,
} from "../src/reliability/decision-gate.js";

test("accepts one final decision and replays the same idempotent request", () => {
  const gate = new InMemoryDecisionGate(
    () => new Date("2026-08-03T00:00:00.000Z"),
  );
  const first = gate.decide("request-1", "key-1", "approve");
  const replay = gate.decide("request-1", "key-1", "approve");

  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.strictEqual(replay.record, first.record);
});

test("rejects a competing final decision", () => {
  const gate = new InMemoryDecisionGate();
  gate.decide("request-1", "approve-key", "approve");

  assert.throws(
    () => gate.decide("request-1", "deny-key", "deny"),
    DecisionConflictError,
  );
  assert.equal(gate.get("request-1")?.decision, "approve");
});

test("rejects reusing an idempotency key with another payload", () => {
  const gate = new InMemoryDecisionGate();
  gate.decide("request-1", "shared-key", "approve");

  assert.throws(
    () => gate.decide("request-2", "shared-key", "approve"),
    /already bound/,
  );
});

