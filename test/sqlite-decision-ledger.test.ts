import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { DecisionConflictError } from "../src/reliability/decision-gate.js";
import { SqliteDecisionLedger } from "../src/reliability/sqlite-decision-ledger.js";

const crashWriterPath = fileURLToPath(
  new URL("./fixtures/write-decision-and-crash.js", import.meta.url),
);

test("persists a final decision across ledger restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "yurupager-ledger-"));
  const databasePath = join(directory, "decisions.sqlite");
  try {
    const first = new SqliteDecisionLedger(databasePath, () =>
      new Date("2026-08-03T00:00:00.000Z"),
    );
    first.decide("request-1", "key-1", "approve");
    first.close();

    const reopened = new SqliteDecisionLedger(databasePath);
    const replay = reopened.decide("request-1", "key-1", "approve");
    assert.equal(replay.replayed, true);
    assert.throws(
      () => reopened.decide("request-1", "key-2", "deny"),
      DecisionConflictError,
    );
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("keeps a committed decision after abrupt process exit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "yurupager-crash-"));
  const databasePath = join(directory, "decisions.sqlite");
  try {
    const child = spawnSync(process.execPath, [crashWriterPath, databasePath], {
      encoding: "utf8",
    });
    assert.equal(child.status, 23, child.stderr);

    const reopened = new SqliteDecisionLedger(databasePath);
    const decision = reopened.get("request-after-crash");
    assert.equal(decision?.decision, "approve");
    assert.equal(
      reopened.decide("request-after-crash", "crash-key", "approve").replayed,
      true,
    );
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

