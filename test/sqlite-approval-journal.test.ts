import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  AmbiguousDeliveryError,
  SqliteApprovalJournal,
} from "../src/reliability/sqlite-approval-journal.js";

test("persists ambiguous delivery and blocks automatic retry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "yurupager-journal-test-"));
  const databasePath = join(directory, "approval.sqlite");
  try {
    const first = new SqliteApprovalJournal(databasePath);
    first.prepare("request-1");
    assert.deepEqual(first.beginDispatch("request-1").state, "sent_unknown");
    first.close();

    const recovered = new SqliteApprovalJournal(databasePath);
    assert.equal(recovered.get("request-1")?.attemptCount, 1);
    assert.throws(
      () => recovered.beginDispatch("request-1"),
      AmbiguousDeliveryError,
    );
    const reconciled = recovered.markReconciled(
      "request-1",
      "turn_completed",
    );
    assert.equal(reconciled.state, "reconciled_completed");
    assert.equal(reconciled.resolution, "turn_completed");
    recovered.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("marks a normal dispatch as delivered", async () => {
  const directory = await mkdtemp(join(tmpdir(), "yurupager-journal-test-"));
  const databasePath = join(directory, "approval.sqlite");
  try {
    const journal = new SqliteApprovalJournal(databasePath);
    journal.prepare("request-2");
    journal.beginDispatch("request-2");
    const delivered = journal.markDelivered("request-2");
    assert.equal(delivered.state, "delivered");
    assert.equal(delivered.attemptCount, 1);
    journal.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
