import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { adaptNotification } from "../codex/adapter.js";
import type { ThreadTokenUsage } from "../codex/domain.js";
import { isRecord } from "../codex/guards.js";
import { CodexAppServerClient } from "../codex/json-rpc-client.js";
import { TokenUsageAccumulator } from "../reliability/token-accumulator.js";

interface ThreadStartResponse {
  thread: { id: string };
}

interface TurnStartResponse {
  turn: { id: string };
}

interface TurnSample {
  label: string;
  turnId: string;
  eventCount: number;
  first: ThreadTokenUsage | null;
  final: ThreadTokenUsage | null;
}

const directory = await mkdtemp(join(tmpdir(), "yurupager-token-life-"));
const accumulator = new TokenUsageAccumulator();
const usageByTurn = new Map<string, ThreadTokenUsage[]>();
const completedTurns = new Set<string>();
const rawNotificationCounts = new Map<string, number>();
let sequence = 0;
let compacted = false;
let threadId = "";

const firstClient = client();
const secondClient = client();
attachObservers(firstClient);
attachObservers(secondClient);

try {
  await firstClient.start();
  await firstClient.initialize({
    name: "yurupager-token-lifecycle-before-restart",
    version: "0.0.1",
  });
  const started = await firstClient.request<ThreadStartResponse>(
    "thread/start",
    {
      cwd: directory,
      ephemeral: false,
      approvalPolicy: "never",
      sandbox: "read-only",
      developerInstructions:
        "Do not use tools. Reply with exactly the text requested by the user.",
    },
  );
  threadId = started.thread.id;

  const first = await runTurn(firstClient, "first", "Reply with exactly: FIRST");
  const second = await runTurn(firstClient, "second", "Reply with exactly: SECOND");

  await firstClient.request("thread/compact/start", { threadId });
  await waitUntil(
    () => compacted,
    120_000,
    "manual context compaction",
  );
  await delay(500);
  const afterCompactionTotal = accumulator.get(threadId)?.total ?? null;

  const third = await runTurn(
    firstClient,
    "after_compaction",
    "Reply with exactly: THIRD",
  );

  await firstClient.stop();
  const eventsBeforeResume = totalUsageEvents();
  await secondClient.start();
  await secondClient.initialize({
    name: "yurupager-token-lifecycle-after-restart",
    version: "0.0.1",
  });
  await secondClient.request("thread/resume", {
    threadId,
    excludeTurns: false,
  });
  await delay(1_000);
  const usageEventsReplayedOnResume = totalUsageEvents() - eventsBeforeResume;
  const fourth = await runTurn(
    secondClient,
    "after_listener_restart",
    "Reply with exactly: FOURTH",
  );

  const samples = [first, second, third, fourth];
  const finalTotals = samples.map((sample) => sample.final?.total.totalTokens);
  const allFinalsPresent = finalTotals.every(
    (total): total is number => total !== undefined,
  );
  const totalsMonotonic =
    allFinalsPresent &&
    finalTotals.every((total, index) =>
      index === 0 ? total > 0 : total > finalTotals[index - 1]!,
    );
  const lastIsPerOperation = samples.every(
    (sample) =>
      sample.final !== null &&
      sample.final.last.totalTokens <= sample.final.total.totalTokens,
  );
  const accumulatorState = accumulator.get(threadId);
  const result = {
    passed:
      compacted &&
      allFinalsPresent &&
      totalsMonotonic &&
      lastIsPerOperation &&
      accumulatorState?.resetDetected === false,
    experimentCompleted: true,
    threadId,
    samples,
    compacted,
    afterCompactionTotal,
    usageEventsReplayedOnResume,
    totalsMonotonicAcrossTurnsCompactionAndRestart: totalsMonotonic,
    counterResetDetected: accumulatorState?.resetDetected ?? null,
    finalAccumulatedTotal: accumulatorState?.total ?? null,
    notificationCounts: Object.fromEntries(rawNotificationCounts),
    conclusion:
      usageEventsReplayedOnResume === 0
        ? "total continues on the next turn; resume alone does not replay a token snapshot"
        : "resume replayed token snapshots before the next turn",
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.passed) {
    process.exitCode = 1;
  }
} finally {
  const cleanupClient = secondClient.running
    ? secondClient
    : firstClient.running
      ? firstClient
      : undefined;
  if (threadId.length > 0 && cleanupClient !== undefined) {
    try {
      await cleanupClient.request("thread/delete", { threadId });
    } catch (error) {
      process.stderr.write(
        `Unable to delete Spike thread ${threadId}: ${String(error)}\n`,
      );
    }
  }
  await Promise.allSettled([firstClient.stop(), secondClient.stop()]);
  await rm(directory, { recursive: true, force: true });
}

function client(): CodexAppServerClient {
  return new CodexAppServerClient({ requestTimeoutMs: 30_000 });
}

function attachObservers(target: CodexAppServerClient): void {
  target.onNotification((notification) => {
    rawNotificationCounts.set(
      notification.method,
      (rawNotificationCounts.get(notification.method) ?? 0) + 1,
    );
    if (notification.method === "thread/compacted") {
      compacted = true;
    } else if (
      notification.method === "item/completed" &&
      isRecord(notification.params) &&
      isRecord(notification.params.item) &&
      notification.params.item.type === "contextCompaction"
    ) {
      compacted = true;
    }
    const event = adaptNotification(notification);
    if (event?.type === "token.usage.updated") {
      const samples = usageByTurn.get(event.turnId) ?? [];
      samples.push(event.usage);
      usageByTurn.set(event.turnId, samples);
      sequence += 1;
      accumulator.ingest({
        eventId: `${event.threadId}:${event.turnId}:${String(sequence)}`,
        sequence,
        threadId: event.threadId,
        turnId: event.turnId,
        usage: event.usage,
        observedAt: new Date().toISOString(),
      });
    } else if (event?.type === "turn.completed") {
      completedTurns.add(event.turnId);
      if (usageByTurn.has(event.turnId)) {
        accumulator.finalizeTurn(event.threadId, event.turnId);
      }
    }
  });
}

async function runTurn(
  target: CodexAppServerClient,
  label: string,
  text: string,
): Promise<TurnSample> {
  const started = await target.request<TurnStartResponse>("turn/start", {
    threadId,
    input: [{ type: "text", text }],
    approvalPolicy: "never",
  });
  const turnId = started.turn.id;
  await waitUntil(
    () => completedTurns.has(turnId),
    120_000,
    `${label} turn completion`,
  );
  await delay(250);
  const samples = usageByTurn.get(turnId) ?? [];
  return {
    label,
    turnId,
    eventCount: samples.length,
    first: samples[0] ?? null,
    final: samples.at(-1) ?? null,
  };
}

function totalUsageEvents(): number {
  return [...usageByTurn.values()].reduce(
    (total, samples) => total + samples.length,
    0,
  );
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
