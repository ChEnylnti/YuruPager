import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  ConnectorRuntime,
  discoverCodexSessionSnapshot,
  discoverCodexSessions,
  dispatchSessionCommand,
  sanitizeSessionTitle,
  sessionPayloadsFromThreadList,
  sessionTitlesFromThreadList,
} from "../src/connector/runtime.js";
import type { CodexAppServerClient, NotificationHandler } from "../src/codex/json-rpc-client.js";
import { SqliteLocalImageStore } from "../src/codex/local-image-store.js";
import { SqliteApprovalJournal } from "../src/reliability/sqlite-approval-journal.js";
import { SqliteCommandJournal } from "../src/reliability/sqlite-command-journal.js";
import { SqliteDecisionLedger } from "../src/reliability/sqlite-decision-ledger.js";
import type {
  ConnectorAttachmentStatus,
  ConnectorCloudClient,
  RemoteAttachmentControl,
  RemoteSessionCommand,
} from "../src/transport/connector-cloud-client.js";

test("reports real Codex sessions without copying preview or raw home paths", async () => {
  const projectPath = join(homedir(), "Documents", "YuruPager");
  const sessions = await sessionPayloadsFromThreadList({
    data: [{
      id: "thread-real",
      cwd: projectPath,
      createdAt: 1_786_000_000,
      updatedAt: 1_786_000_120,
      status: { type: "active", activeFlags: ["waitingOnApproval"] },
      name: "创建私人仓库并提交项目",
      preview: "A complete private agent conversation that must never leave the Connector",
      path: "/private/rollout.jsonl",
      gitInfo: { branch: "secret" },
    }],
  }, {
    model: "gpt-5.6-codex",
  }, async (path) => path);

  assert.deepEqual(sessions, [{
    type: "session.upsert",
    threadId: "thread-real",
    agent: "codex",
    sessionId: "thread-real",
    projectKey: createHash("sha256").update(projectPath).digest("hex"),
    projectName: "YuruPager",
    projectPath: "~/Documents/YuruPager",
    model: "gpt-5.6-codex",
    status: "waiting",
    syncState: "live",
    startedAt: new Date(1_786_000_000_000).toISOString(),
    updatedAt: new Date(1_786_000_120_000).toISOString(),
  }]);
  assert.equal(JSON.stringify(sessions).includes("private agent conversation"), false);
  assert.equal(JSON.stringify(sessions).includes("创建私人仓库并提交项目"), false);
});

test("extracts only bounded official Codex names for the ephemeral title channel", () => {
  const title = `${"会".repeat(130)}\u202e\n  项目`;
  const titles = sessionTitlesFromThreadList({
    data: [
      { id: "thread-title", name: title, preview: "完整首条用户消息不得被当成标题" },
      { id: "thread-preview-only", preview: "没有 name 时不能回退到 preview" },
      { id: "thread-empty", name: "\u202e\n" },
    ],
  });

  assert.equal(titles.length, 1);
  assert.equal(titles[0]?.threadId, "thread-title");
  assert.equal(Array.from(titles[0]?.title ?? "").length, 120);
  assert.equal(JSON.stringify(titles).includes("完整首条用户消息"), false);
  assert.equal(sanitizeSessionTitle("  Explain\t agent   vs workflow \u2066 "), "Explain agent vs workflow");
});

test("retains threads with relative paths or newer statuses for client parity", async () => {
  const sessions = await sessionPayloadsFromThreadList({
    data: [
      { id: "other", cwd: "/another/trace-agent", status: { type: "idle" } },
      { id: "relative", cwd: "relative/project", status: { type: "idle" } },
      { id: "unknown", cwd: "/workspace", status: { type: "futureStatus" } },
    ],
  }, {
    model: "gpt-5.6-codex",
  }, async (path) => path);
  assert.equal(sessions.length, 3);
  assert.equal(sessions.find((session) => session.threadId === "other")?.projectName, "trace-agent");
  assert.equal(sessions.find((session) => session.threadId === "other")?.projectPath, "trace-agent");
  assert.equal(sessions.find((session) => session.threadId === "relative")?.projectName, "未归类会话");
  assert.equal(sessions.find((session) => session.threadId === "unknown")?.syncState, "historical");
});

test("does not label unloaded Codex history as waiting for input", async () => {
  const sessions = await sessionPayloadsFromThreadList({
    data: [{ id: "old-thread", cwd: "/projects/archive", status: { type: "notLoaded" } }],
  }, { model: "gpt-5.6-codex" }, async (path) => path);
  assert.equal(sessions[0]?.status, "completed");
  assert.equal(sessions[0]?.syncState, "historical");
});

test("preserves Codex raw cwd identities for project parity", async () => {
  const sessions = await sessionPayloadsFromThreadList({
    data: [
      { id: "alias-thread", cwd: "/tmp/project-link", status: { type: "idle" } },
      { id: "real-thread", cwd: "/srv/projects/trace-agent", status: { type: "idle" } },
    ],
  }, { model: "gpt-5.6-codex" }, async () => "/srv/projects/trace-agent");
  assert.notEqual(sessions[0]?.projectKey, sessions[1]?.projectKey);
  assert.equal(sessions.find((session) => session.threadId === "alias-thread")?.projectName, "project-link");
  assert.equal(sessions.find((session) => session.threadId === "real-thread")?.projectName, "trace-agent");
});

test("paginates the global Codex thread inventory without a cwd filter", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const codex = fakeCodex(async (method, params) => {
    assert.equal(method, "thread/list");
    const input = params as Record<string, unknown>;
    calls.push(input);
    return input.cursor === "page-two"
      ? { data: [{ id: "thread-two", cwd: "/projects/trace-agent", status: { type: "idle" } }], nextCursor: null }
      : { data: [{ id: "thread-one", cwd: "/projects/YuruPager", status: { type: "idle" } }], nextCursor: "page-two" };
  });

  const sessions = await discoverCodexSessions(codex, { model: "gpt-5.6-codex" });
  assert.deepEqual(sessions.map((session) => session.projectName), ["YuruPager", "trace-agent"]);
  assert.equal(calls.length, 2);
  assert.equal("cwd" in (calls[0] ?? {}), false);
  assert.equal(calls[1]?.cursor, "page-two");
  assert.equal(calls.every((call) => call.limit === 100 && call.archived === false), true);
});

test("discovers session metadata and official titles in the same pagination pass", async () => {
  let calls = 0;
  const codex = fakeCodex(async () => {
    calls += 1;
    return {
      data: [{
        id: "thread-one",
        cwd: "/projects/YuruPager",
        status: { type: "idle" },
        name: "定义 YuruPager MVP 产品需求",
        preview: "完整需求正文",
      }],
      nextCursor: null,
    };
  });

  const snapshot = await discoverCodexSessionSnapshot(codex, { model: "gpt-5.6-codex" });
  assert.equal(calls, 1);
  assert.equal(snapshot.sessions[0]?.threadId, "thread-one");
  assert.deepEqual(snapshot.titles, [{ threadId: "thread-one", title: "定义 YuruPager MVP 产品需求" }]);
  assert.equal(JSON.stringify(snapshot).includes("完整需求正文"), false);
});

test("keeps titles off the durable channel and re-sends them after reconnect", async () => {
  const directory = await mkdtemp(join(tmpdir(), "yurupager-title-runtime-"));
  const journal = new SqliteApprovalJournal(join(directory, "approvals.sqlite"));
  const commands = new SqliteCommandJournal(join(directory, "commands.sqlite"));
  const decisions = new SqliteDecisionLedger(join(directory, "decisions.sqlite"));
  const durable: unknown[] = [];
  const ephemeral: unknown[] = [];
  let statusHandler: ((online: boolean) => void) | undefined;
  const cloud = {
    onDecision: () => () => undefined,
    onCommand: () => () => undefined,
    onSessionStream: () => () => undefined,
    onStatus(handler: (online: boolean) => void) { statusHandler = handler; return () => undefined; },
    start: () => undefined,
    stop: async () => undefined,
    send(value: unknown) { durable.push(value); return {}; },
    sendEphemeral(value: unknown) { ephemeral.push(value); return true; },
  } as unknown as ConnectorCloudClient;
  const codex = {
    setServerRequestHandler: () => undefined,
    onNotification: () => () => undefined,
    start: async () => undefined,
    stop: async () => undefined,
    initialize: async () => ({ codexHome: "/tmp/codex", platformFamily: "unix", platformOs: "macos", userAgent: "test" }),
    request: async (method: string) => method === "thread/list"
      ? { data: [{ id: "thread-title", cwd: "/projects/YuruPager", status: { type: "idle" }, name: "创建私人仓库并提交项目", preview: "完整正文" }], nextCursor: null }
      : {},
  } as unknown as CodexAppServerClient;
  const runtime = new ConnectorRuntime({
    cloud,
    codex,
    journal,
    commands,
    decisions,
    skipVersionGate: true,
    workstationName: "Test Mac",
    platform: "macOS",
    connectorVersion: "0.2.0-alpha",
    projectName: "YuruPager",
    projectPath: "/projects/YuruPager",
    model: "gpt-5.6-codex",
    sessionRefreshMs: 0,
  });

  try {
    await runtime.start();
    assert.equal(JSON.stringify(durable).includes("创建私人仓库并提交项目"), false);
    assert.equal(JSON.stringify(durable).includes("完整正文"), false);
    assert.equal(JSON.stringify(ephemeral).includes("创建私人仓库并提交项目"), true);
    ephemeral.length = 0;
    statusHandler?.(true);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    assert.deepEqual(ephemeral, [{
      type: "session.titles.snapshot",
      titles: [{ threadId: "thread-title", title: "创建私人仓库并提交项目" }],
    }]);
  } finally {
    await runtime.stop();
    journal.close();
    commands.close();
    decisions.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("streams native activity immediately and polls other Codex processes for text deltas", async () => {
  const directory = await mkdtemp(join(tmpdir(), "yurupager-live-runtime-"));
  const journal = new SqliteApprovalJournal(join(directory, "approvals.sqlite"));
  const commands = new SqliteCommandJournal(join(directory, "commands.sqlite"));
  const decisions = new SqliteDecisionLedger(join(directory, "decisions.sqlite"));
  const ephemeral: unknown[] = [];
  let streamHandler: Parameters<ConnectorCloudClient["onSessionStream"]>[0] | undefined;
  let notificationHandler: NotificationHandler | undefined;
  let threadRead: unknown = {
    thread: { id: "thread-live", turns: [] },
  };
  const cloud = {
    onDecision: () => () => undefined,
    onCommand: () => () => undefined,
    onSessionStream(handler: Parameters<ConnectorCloudClient["onSessionStream"]>[0]) { streamHandler = handler; return () => undefined; },
    onStatus: () => () => undefined,
    start: () => undefined,
    stop: async () => undefined,
    send: () => ({}),
    sendEphemeral(value: unknown) { ephemeral.push(value); return true; },
  } as unknown as ConnectorCloudClient;
  const codex = {
    setServerRequestHandler: () => undefined,
    onNotification(handler: NotificationHandler) { notificationHandler = handler; return () => undefined; },
    start: async () => undefined,
    stop: async () => undefined,
    initialize: async () => ({ codexHome: "/tmp/codex", platformFamily: "unix", platformOs: "macos", userAgent: "test" }),
    request: async (method: string) => {
      if (method === "thread/list") return { data: [], nextCursor: null };
      if (method === "thread/read") return threadRead;
      return {};
    },
  } as unknown as CodexAppServerClient;
  const runtime = new ConnectorRuntime({
    cloud,
    codex,
    journal,
    commands,
    decisions,
    skipVersionGate: true,
    workstationName: "Test Mac",
    platform: "macOS",
    connectorVersion: "0.2.0-alpha",
    projectName: "YuruPager",
    projectPath: "/projects/YuruPager",
    model: "gpt-5.6-codex",
    sessionRefreshMs: 0,
    sessionStreamPollMs: 20,
  });

  try {
    await runtime.start();
    await streamHandler?.({ type: "session.stream.subscribe", subscriptionId: "subscription-live", threadId: "thread-live" });
    assert.equal(ephemeral.some((value) => JSON.stringify(value).includes("history.complete")), true);

    await notificationHandler?.({
      method: "item/started",
      params: {
        threadId: "thread-live",
        turnId: "turn-live",
        item: { id: "command-live", type: "commandExecution", command: "SECRET_COMMAND", commandActions: [{ type: "read", path: "/private/main.mjs" }], status: "inProgress" },
      },
    });
    assert.equal(ephemeral.some((value) => JSON.stringify(value).includes('"label":"读取 main.mjs"')), true);
    assert.equal(JSON.stringify(ephemeral).includes("SECRET_COMMAND"), false);

    threadRead = {
      thread: {
        id: "thread-live",
        turns: [{
          id: "turn-live",
          status: "inProgress",
          items: [
            { id: "command-live", type: "commandExecution", command: "SECRET_COMMAND", commandActions: [{ type: "read", path: "/private/main.mjs" }], status: "completed", aggregatedOutput: "SECRET_OUTPUT" },
            { id: "agent-live", type: "agentMessage", text: "正在检查", phase: "commentary" },
          ],
        }],
      },
    };
    await waitFor(() => ephemeral.some((value) => JSON.stringify(value).includes('"delta":"正在检查"')));
    assert.equal(JSON.stringify(ephemeral).includes("SECRET_OUTPUT"), false);

    threadRead = {
      thread: {
        id: "thread-live",
        turns: [{
          id: "turn-live",
          status: "inProgress",
          items: [
            { id: "command-live", type: "commandExecution", status: "completed" },
            { id: "agent-live", type: "agentMessage", text: "正在检查页面", phase: "commentary" },
          ],
        }],
      },
    };
    await waitFor(() => ephemeral.some((value) => JSON.stringify(value).includes('"delta":"页面"')));
  } finally {
    await runtime.stop();
    journal.close();
    commands.close();
    decisions.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("fails closed on a repeated Codex pagination cursor", async () => {
  const codex = fakeCodex(async () => ({ data: [], nextCursor: "same-cursor" }));
  await assert.rejects(
    discoverCodexSessions(codex, { model: "gpt-5.6-codex" }),
    /repeated pagination cursor/,
  );
});

test("bridges attachment controls into private local media and returns resumable statuses", async () => {
  const directory = await mkdtemp(join(tmpdir(), "yurupager-runtime-media-"));
  const journal = new SqliteApprovalJournal(join(directory, "approvals.sqlite"));
  const commands = new SqliteCommandJournal(join(directory, "commands.sqlite"));
  const decisions = new SqliteDecisionLedger(join(directory, "decisions.sqlite"));
  const media = new SqliteLocalImageStore(join(directory, "media.sqlite"), join(directory, "images"));
  const statuses: ConnectorAttachmentStatus[] = [];
  let attachmentHandler: ((control: RemoteAttachmentControl) => Promise<void> | void) | undefined;
  const cloud = {
    onDecision: () => () => undefined,
    onCommand: () => () => undefined,
    onSessionStream: () => () => undefined,
    onAttachment(handler: typeof attachmentHandler) { attachmentHandler = handler; return () => undefined; },
    onStatus: () => () => undefined,
    start: () => undefined,
    stop: async () => undefined,
    send: () => ({}),
    sendEphemeral: () => true,
    sendAttachmentStatus(status: ConnectorAttachmentStatus) { statuses.push(status); return true; },
  } as unknown as ConnectorCloudClient;
  const codex = {
    setServerRequestHandler: () => undefined,
    onNotification: () => () => undefined,
    stop: async () => undefined,
  } as unknown as CodexAppServerClient;
  const runtime = new ConnectorRuntime({
    cloud,
    codex,
    journal,
    commands,
    decisions,
    media,
    skipVersionGate: true,
    workstationName: "Test Mac",
    platform: "macOS",
    connectorVersion: "0.2.0-alpha",
    projectName: "YuruPager",
    projectPath: "/projects/YuruPager",
    model: "gpt-5.6-codex",
  });
  const bytes = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from("runtime-bridge")]);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  try {
    await attachmentHandler?.({
      type: "session.attachment.begin",
      transferId: "transfer-runtime",
      uploadId: "upload-runtime",
      threadId: "thread-runtime",
      mimeType: "image/png",
      byteLength: bytes.length,
      sha256,
    });
    await attachmentHandler?.({
      type: "session.attachment.chunk",
      transferId: "transfer-runtime",
      uploadId: "upload-runtime",
      offset: 0,
      data: bytes.toString("base64"),
    });
    await attachmentHandler?.({
      type: "session.attachment.complete",
      transferId: "transfer-runtime",
      uploadId: "upload-runtime",
    });
    assert.deepEqual(statuses.map((status) => status.state), ["accepted", "progress", "ready"]);
    const ready = statuses[2];
    assert.equal(typeof ready?.attachmentId, "string");
    assert.equal(JSON.stringify(statuses).includes("/projects/"), false);
    assert.equal(JSON.stringify(statuses).includes("runtime-bridge"), false);
    assert.equal(media.resolveAttachment({
      attachmentId: ready?.attachmentId ?? "",
      mimeType: "image/png",
      byteLength: bytes.length,
      sha256,
    }, "thread-runtime").byteLength, bytes.length);
  } finally {
    await runtime.stop();
    media.close();
    journal.close();
    commands.close();
    decisions.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("starts one turn for an idempotently replayed remote session command", async () => {
  await withCommandJournal(async (journal) => {
    const methods: string[] = [];
    const codex = fakeCodex(async (method) => {
      methods.push(method);
      return method === "turn/start" ? { turn: { id: "turn-command-1" } } : {};
    });
    const command = remoteCommand("command-delivered");

    const first = await dispatchSessionCommand(codex, journal, command);
    const replay = await dispatchSessionCommand(codex, journal, command);

    assert.equal(first.state, "delivered");
    assert.equal(first.turnId, "turn-command-1");
    assert.equal(replay.state, "delivered");
    assert.deepEqual(methods, ["thread/resume", "turn/start"]);
  });
});

test("releases a remote thread writer only after a terminal turn", async () => {
  const directory = await mkdtemp(join(tmpdir(), "yurupager-writer-runtime-"));
  const journal = new SqliteApprovalJournal(join(directory, "approvals.sqlite"));
  const commands = new SqliteCommandJournal(join(directory, "commands.sqlite"));
  const decisions = new SqliteDecisionLedger(join(directory, "decisions.sqlite"));
  let commandHandler: Parameters<ConnectorCloudClient["onCommand"]>[0] | undefined;
  let turnNotificationHandler: NotificationHandler | undefined;
  const turnMethods: string[] = [];
  let turnStops = 0;
  let turnStartRequested = false;
  let resolveTurnStart: ((value: unknown) => void) | undefined;
  const cloud = {
    onDecision: () => () => undefined,
    onCommand(handler: Parameters<ConnectorCloudClient["onCommand"]>[0]) { commandHandler = handler; return () => undefined; },
    onSessionStream: () => () => undefined,
    onStatus: () => () => undefined,
    start: () => undefined,
    stop: async () => undefined,
    send: () => ({}),
    sendEphemeral: () => true,
  } as unknown as ConnectorCloudClient;
  const codex = {
    setServerRequestHandler: () => undefined,
    onNotification: () => () => undefined,
    start: async () => undefined,
    stop: async () => undefined,
    initialize: async () => ({ codexHome: "/tmp/codex", platformFamily: "unix", platformOs: "macos", userAgent: "test" }),
    request: async (method: string) => {
      if (method === "thread/list") return { data: [], nextCursor: null };
      return {};
    },
  } as unknown as CodexAppServerClient;
  const createTurnClient = () => ({
    setServerRequestHandler: () => undefined,
    onNotification(handler: NotificationHandler) { turnNotificationHandler = handler; return () => undefined; },
    start: async () => undefined,
    stop: async () => { turnStops += 1; },
    initialize: async () => ({ codexHome: "/tmp/codex", platformFamily: "unix", platformOs: "macos", userAgent: "test" }),
    request: async (method: string) => {
      turnMethods.push(method);
      if (method === "turn/start") {
        turnStartRequested = true;
        return new Promise<unknown>((resolve) => { resolveTurnStart = resolve; });
      }
      return {};
    },
  } as unknown as CodexAppServerClient);
  const runtime = new ConnectorRuntime({
    cloud,
    codex,
    journal,
    commands,
    decisions,
    skipVersionGate: true,
    workstationName: "Test Mac",
    platform: "macOS",
    connectorVersion: "0.2.0-alpha",
    projectName: "YuruPager",
    projectPath: "/projects/YuruPager",
    model: "gpt-5.6-codex",
    sessionRefreshMs: 0,
    turnClientReleaseDelayMs: 0,
    createTurnClient,
  });

  try {
    await runtime.start();
    const command = commandHandler?.(remoteCommand("command-release"));
    await waitFor(() => turnStartRequested);
    assert.deepEqual(turnMethods, ["thread/resume", "turn/start"]);
    assert.equal(turnStops, 0);

    await turnNotificationHandler?.({
      method: "error",
      params: {
        threadId: "thread-real",
        turnId: "turn-release",
        willRetry: true,
        error: { message: "429 Too Many Requests" },
      },
    });
    assert.equal(turnStops, 0);

    const completed = {
      method: "turn/completed",
      params: {
        threadId: "thread-real",
        turn: { id: "turn-release", status: "failed" },
      },
    };
    await turnNotificationHandler?.(completed);
    assert.equal(turnStops, 0);
    resolveTurnStart?.({ turn: { id: "turn-release" } });
    await command;
    await waitFor(() => turnStops === 1);

    await turnNotificationHandler?.(completed);
    assert.equal(turnStops, 1);
  } finally {
    await runtime.stop();
    journal.close();
    commands.close();
    decisions.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("serializes same-thread remote commands until the prior writer has stopped", async () => {
  const directory = await mkdtemp(join(tmpdir(), "yurupager-command-queue-runtime-"));
  const journal = new SqliteApprovalJournal(join(directory, "approvals.sqlite"));
  const commands = new SqliteCommandJournal(join(directory, "commands.sqlite"));
  const decisions = new SqliteDecisionLedger(join(directory, "decisions.sqlite"));
  let commandHandler: Parameters<ConnectorCloudClient["onCommand"]>[0] | undefined;
  const sent: unknown[] = [];
  const calls: string[] = [];
  const writerNotifications: NotificationHandler[] = [];
  let writerCount = 0;
  const cloud = {
    onDecision: () => () => undefined,
    onCommand(handler: Parameters<ConnectorCloudClient["onCommand"]>[0]) { commandHandler = handler; return () => undefined; },
    onSessionStream: () => () => undefined,
    onStatus: () => () => undefined,
    start: () => undefined,
    stop: async () => undefined,
    send(value: unknown) { sent.push(value); return {}; },
    sendEphemeral: () => true,
  } as unknown as ConnectorCloudClient;
  const codex = {
    setServerRequestHandler: () => undefined,
    onNotification: () => () => undefined,
    start: async () => undefined,
    stop: async () => undefined,
    initialize: async () => ({ codexHome: "/tmp/codex", platformFamily: "unix", platformOs: "macos", userAgent: "test" }),
    request: async (method: string) => method === "thread/list" ? { data: [], nextCursor: null } : {},
  } as unknown as CodexAppServerClient;
  const createTurnClient = () => {
    const writerId = ++writerCount;
    return {
      setServerRequestHandler: () => undefined,
      onNotification(handler: NotificationHandler) { writerNotifications[writerId - 1] = handler; return () => undefined; },
      start: async () => undefined,
      stop: async () => { calls.push(`${writerId}:stop`); },
      initialize: async () => ({ codexHome: "/tmp/codex", platformFamily: "unix", platformOs: "macos", userAgent: "test" }),
      request: async (method: string) => {
        calls.push(`${writerId}:${method}`);
        return method === "turn/start" ? { turn: { id: `turn-${writerId}` } } : {};
      },
    } as unknown as CodexAppServerClient;
  };
  const runtime = new ConnectorRuntime({
    cloud,
    codex,
    journal,
    commands,
    decisions,
    skipVersionGate: true,
    workstationName: "Test Mac",
    platform: "macOS",
    connectorVersion: "0.2.0-alpha",
    projectName: "YuruPager",
    projectPath: "/projects/YuruPager",
    model: "gpt-5.6-codex",
    sessionRefreshMs: 0,
    turnClientReleaseDelayMs: 0,
    createTurnClient,
  });

  try {
    await runtime.start();
    const first = commandHandler?.(remoteCommand("command-queue-first"));
    await waitFor(() => calls.includes("1:turn/start"));
    await first;

    let secondSettled = false;
    const second = commandHandler?.({
      ...remoteCommand("command-queue-second"),
      sequence: 2,
    });
    void second?.then(() => { secondSettled = true; });

    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(calls, ["1:thread/resume", "1:turn/start"]);
    assert.equal(secondSettled, false);
    assert.equal(writerCount, 1);

    await writerNotifications[0]?.({
      method: "turn/completed",
      params: {
        threadId: "thread-real",
        turn: { id: "turn-1", status: "completed" },
      },
    });
    await waitFor(() => calls.includes("1:stop"));
    await waitFor(() => calls.includes("2:turn/start"));
    await second;

    assert.deepEqual(calls, [
      "1:thread/resume",
      "1:turn/start",
      "1:stop",
      "2:thread/resume",
      "2:turn/start",
    ]);
    assert.equal(secondSettled, true);
    assert.equal(sent.some((value) => JSON.stringify(value).includes('"type":"turn.completed"')), true);
  } finally {
    await runtime.stop();
    journal.close();
    commands.close();
    decisions.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("keeps later same-thread commands pending after an ambiguous turn start", async () => {
  const directory = await mkdtemp(join(tmpdir(), "yurupager-command-unknown-queue-"));
  const journal = new SqliteApprovalJournal(join(directory, "approvals.sqlite"));
  const commands = new SqliteCommandJournal(join(directory, "commands.sqlite"));
  const decisions = new SqliteDecisionLedger(join(directory, "decisions.sqlite"));
  let commandHandler: Parameters<ConnectorCloudClient["onCommand"]>[0] | undefined;
  let writerNotification: NotificationHandler | undefined;
  const calls: string[] = [];
  const cloud = {
    onDecision: () => () => undefined,
    onCommand(handler: Parameters<ConnectorCloudClient["onCommand"]>[0]) { commandHandler = handler; return () => undefined; },
    onSessionStream: () => () => undefined,
    onStatus: () => () => undefined,
    start: () => undefined,
    stop: async () => undefined,
    send: () => ({}),
    sendEphemeral: () => true,
  } as unknown as ConnectorCloudClient;
  const codex = {
    setServerRequestHandler: () => undefined,
    onNotification: () => () => undefined,
    start: async () => undefined,
    stop: async () => undefined,
    initialize: async () => ({ codexHome: "/tmp/codex", platformFamily: "unix", platformOs: "macos", userAgent: "test" }),
    request: async (method: string) => method === "thread/list" ? { data: [], nextCursor: null } : {},
  } as unknown as CodexAppServerClient;
  const createTurnClient = () => ({
    setServerRequestHandler: () => undefined,
    onNotification(handler: NotificationHandler) { writerNotification = handler; return () => undefined; },
    start: async () => undefined,
    stop: async () => { calls.push("stop"); },
    initialize: async () => ({ codexHome: "/tmp/codex", platformFamily: "unix", platformOs: "macos", userAgent: "test" }),
    request: async (method: string) => {
      calls.push(method);
      if (method === "turn/start") throw new Error("response lost after write");
      return {};
    },
  } as unknown as CodexAppServerClient);
  const runtime = new ConnectorRuntime({
    cloud,
    codex,
    journal,
    commands,
    decisions,
    skipVersionGate: true,
    workstationName: "Test Mac",
    platform: "macOS",
    connectorVersion: "0.2.0-alpha",
    projectName: "YuruPager",
    projectPath: "/projects/YuruPager",
    model: "gpt-5.6-codex",
    sessionRefreshMs: 0,
    turnClientReleaseDelayMs: 0,
    createTurnClient,
  });

  try {
    await runtime.start();
    await commandHandler?.(remoteCommand("command-unknown-first"));
    assert.deepEqual(calls, ["thread/resume", "turn/start"]);

    let secondSettled = false;
    const second = commandHandler?.({
      ...remoteCommand("command-unknown-second"),
      sequence: 2,
    });
    void second?.then(() => { secondSettled = true; }, () => undefined);

    await writerNotification?.({
      method: "turn/completed",
      params: {
        threadId: "thread-real",
        turn: { id: "turn-unknown", status: "completed" },
      },
    });
    await waitFor(() => calls.includes("stop"));
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    assert.deepEqual(calls, ["thread/resume", "turn/start", "stop"]);
    assert.equal(secondSettled, false);
  } finally {
    await runtime.stop();
    journal.close();
    commands.close();
    decisions.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("does not retry turn/start after an ambiguous failure", async () => {
  await withCommandJournal(async (journal) => {
    let turnStarts = 0;
    const codex = fakeCodex(async (method) => {
      if (method === "turn/start") {
        turnStarts += 1;
        throw new Error("response lost after write");
      }
      return {};
    });
    const command = remoteCommand("command-unknown");

    assert.equal((await dispatchSessionCommand(codex, journal, command)).state, "sent_unknown");
    assert.equal((await dispatchSessionCommand(codex, journal, command)).state, "sent_unknown");
    assert.equal(turnStarts, 1);
  });
});

test("marks a safe thread/resume failure without touching turn/start", async () => {
  await withCommandJournal(async (journal) => {
    let turnStarts = 0;
    const codex = fakeCodex(async (method) => {
      if (method === "thread/resume") throw new Error("thread missing");
      turnStarts += 1;
      return { turn: { id: "unexpected" } };
    });

    const result = await dispatchSessionCommand(codex, journal, remoteCommand("command-failed"));
    assert.equal(result.state, "failed");
    assert.equal(result.errorCode, "thread_resume_failed");
    assert.equal(turnStarts, 0);
  });
});

test("validates staged images before one image-only turn and binds replay to the payload hash", async () => {
  const directory = await mkdtemp(join(tmpdir(), "yurupager-command-image-"));
  const journal = new SqliteCommandJournal(join(directory, "commands.sqlite"));
  const media = new SqliteLocalImageStore(join(directory, "media.sqlite"), join(directory, "images"));
  const bytes = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from("command-image")]);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  try {
    media.beginUpload({
      uploadId: "upload-command-image",
      threadId: "thread-real",
      mimeType: "image/png",
      byteLength: bytes.length,
      sha256,
    });
    media.appendChunk("upload-command-image", 0, bytes.toString("base64"));
    const staged = media.completeUpload("upload-command-image");
    assert.equal(staged.state, "ready");
    if (staged.state !== "ready") return;

    const calls: Array<{ method: string; params: unknown }> = [];
    const codex = fakeCodex(async (method, params) => {
      calls.push({ method, params });
      return method === "turn/start" ? { turn: { id: "turn-image" } } : {};
    });
    const command: RemoteSessionCommand = {
      ...remoteCommand("command-image"),
      text: "",
      attachments: [staged.attachment],
    };
    const delivered = await dispatchSessionCommand(codex, journal, command, media);
    assert.equal(delivered.state, "delivered");
    assert.match(delivered.payloadHash, /^[a-f0-9]{64}$/u);
    assert.equal(calls.length, 2);
    const turnStart = calls[1];
    assert.equal(turnStart?.method, "turn/start");
    const serializedInput = JSON.stringify(turnStart?.params);
    assert.match(serializedInput, /"type":"localImage"/u);
    assert.equal(serializedInput.includes("upload-command-image"), false);

    await assert.rejects(
      () => dispatchSessionCommand(codex, journal, { ...command, text: "different replay" }, media),
      /payload does not match/u,
    );
    assert.equal(calls.length, 2);
  } finally {
    media.close();
    journal.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("fails a missing image before resume and never retries an image turn after sent_unknown", async () => {
  const directory = await mkdtemp(join(tmpdir(), "yurupager-command-image-boundary-"));
  const journal = new SqliteCommandJournal(join(directory, "commands.sqlite"));
  const media = new SqliteLocalImageStore(join(directory, "media.sqlite"), join(directory, "images"));
  let calls = 0;
  const codex = fakeCodex(async (method) => {
    calls += 1;
    if (method === "turn/start") throw new Error("response lost after write");
    return {};
  });
  try {
    const missing: RemoteSessionCommand = {
      ...remoteCommand("command-missing-image"),
      text: "",
      attachments: [{
        attachmentId: "missing-attachment",
        mimeType: "image/png",
        byteLength: 8,
        sha256: "a".repeat(64),
      }],
    };
    const failed = await dispatchSessionCommand(codex, journal, missing, media);
    assert.equal(failed.state, "failed");
    assert.equal(failed.errorCode, "attachment_unavailable");
    assert.equal(calls, 0);

    const metadata = missing.attachments[0]!;
    const tooMany = await dispatchSessionCommand(codex, journal, {
      ...missing,
      commandId: "command-too-many-images",
      messageId: "message-command-too-many-images",
      attachments: Array.from({ length: 5 }, (_value, index) => ({
        ...metadata,
        attachmentId: `missing-${index}`,
      })),
    }, media);
    assert.equal(tooMany.state, "failed");
    assert.equal(tooMany.errorCode, "too_many_images");
    assert.equal(calls, 0);

    const tooLarge = await dispatchSessionCommand(codex, journal, {
      ...missing,
      commandId: "command-images-too-large",
      messageId: "message-command-images-too-large",
      attachments: Array.from({ length: 3 }, (_value, index) => ({
        ...metadata,
        attachmentId: `large-missing-${index}`,
        byteLength: 5 * 1024 * 1024,
      })),
    }, media);
    assert.equal(tooLarge.state, "failed");
    assert.equal(tooLarge.errorCode, "images_too_large");
    assert.equal(calls, 0);

    const bytes = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from("ambiguous")]);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    media.beginUpload({ uploadId: "upload-ambiguous", threadId: "thread-real", mimeType: "image/png", byteLength: bytes.length, sha256 });
    media.appendChunk("upload-ambiguous", 0, bytes.toString("base64"));
    const staged = media.completeUpload("upload-ambiguous");
    assert.equal(staged.state, "ready");
    if (staged.state !== "ready") return;
    const command: RemoteSessionCommand = {
      ...remoteCommand("command-ambiguous-image"),
      attachments: [staged.attachment],
    };
    assert.equal((await dispatchSessionCommand(codex, journal, command, media)).state, "sent_unknown");
    assert.equal((await dispatchSessionCommand(codex, journal, command, media)).state, "sent_unknown");
    assert.equal(calls, 2);
  } finally {
    media.close();
    journal.close();
    await rm(directory, { recursive: true, force: true });
  }
});

function remoteCommand(commandId: string): RemoteSessionCommand {
  return {
    type: "session.command",
    messageId: `message-${commandId}`,
    sequence: 1,
    commandId,
    threadId: "thread-real",
    text: "Continue with the focused verification.",
    attachments: [],
  };
}

function fakeCodex(
  request: (method: string, params: unknown) => Promise<unknown>,
): Pick<CodexAppServerClient, "request"> {
  return { request } as unknown as Pick<CodexAppServerClient, "request">;
}

async function withCommandJournal(
  run: (journal: SqliteCommandJournal) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "yurupager-command-"));
  const journal = new SqliteCommandJournal(join(directory, "commands.sqlite"));
  try {
    await run(journal);
  } finally {
    journal.close();
    await rm(directory, { recursive: true, force: true });
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for runtime state");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}
