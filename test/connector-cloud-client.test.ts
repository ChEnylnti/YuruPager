import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";

import { WebSocketServer } from "ws";

import { ConnectorCloudClient } from "../src/transport/connector-cloud-client.js";
import { SqliteMessageStore } from "../src/transport/sqlite-message-store.js";

test("reconnects after an offline start and replays an event when its ACK is lost", async () => {
  const directory = await mkdtemp(join(tmpdir(), "yurupager-cloud-"));
  const path = join(directory, "transport.sqlite");
  const port = await getFreePort();
  const store = new SqliteMessageStore(path);
  const received: string[] = [];
  const client = new ConnectorCloudClient({
    url: `ws://127.0.0.1:${port}`,
    token: "test-token",
    store,
    reconnectMinMs: 10,
    reconnectMaxMs: 20,
    random: () => 0.5,
  });
  let server: WebSocketServer | undefined;

  try {
    client.start();
    const queued = client.send({
      type: "workstation.heartbeat",
      name: "Test Mac",
      platform: "macOS",
      connectorVersion: "test",
    }, "offline-heartbeat");
    await waitFor(() => !client.online);

    server = new WebSocketServer({ host: "127.0.0.1", port });
    server.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (message.type === "hello") {
          socket.send(JSON.stringify({ type: "welcome", connectionEpoch: "server", lastAcceptedSequence: 0 }));
          return;
        }
        if (message.type !== "event" || typeof message.messageId !== "string") return;
        received.push(message.messageId);
        if (received.length === 1) {
          socket.close(1012, "Simulated ACK loss");
        } else {
          socket.send(JSON.stringify({ type: "ack", messageId: message.messageId, sequence: message.sequence }));
        }
      });
    });

    await waitFor(() => store.pending().length === 0, 3_000);
    assert.ok(received.length >= 2);
    assert.ok(received.every((messageId) => messageId === queued.messageId));
  } finally {
    await client.stop();
    await closeServer(server);
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("replays a durable outbox after the Connector process restarts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "yurupager-cloud-restart-"));
  const path = join(directory, "transport.sqlite");
  const first = new SqliteMessageStore(path);
  const queued = first.enqueue({
    type: "delivery.updated",
    requestId: "request-restart",
    deliveryStatus: "sent_unknown",
  }, "sent-unknown:request-restart");
  first.close();

  const port = await getFreePort();
  const server = new WebSocketServer({ host: "127.0.0.1", port });
  const replayed = new Promise<string>((resolve) => {
    server.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (message.type === "hello") {
          socket.send(JSON.stringify({ type: "welcome", connectionEpoch: "server", lastAcceptedSequence: 0 }));
        } else if (message.type === "event" && typeof message.messageId === "string") {
          socket.send(JSON.stringify({ type: "ack", messageId: message.messageId, sequence: message.sequence }));
          resolve(message.messageId);
        }
      });
    });
  });
  const reopened = new SqliteMessageStore(path);
  const client = new ConnectorCloudClient({
    url: `ws://127.0.0.1:${port}`,
    token: "test-token",
    store: reopened,
    reconnectMinMs: 10,
  });

  try {
    client.start();
    assert.equal(await withTimeout(replayed, 2_000), queued.messageId);
    await waitFor(() => reopened.pending().length === 0);
  } finally {
    await client.stop();
    await closeServer(server);
    reopened.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("retries an Inbox item that was persisted but not processed before restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "yurupager-inbox-restart-"));
  const path = join(directory, "transport.sqlite");
  try {
    const first = new SqliteMessageStore(path);
    assert.equal(first.acceptInbound("decision-1", 1, { type: "decision" }), true);
    first.close();

    const reopened = new SqliteMessageStore(path);
    assert.equal(reopened.acceptInbound("decision-1", 1, { type: "decision" }), true);
    reopened.markInboundProcessed("decision-1");
    assert.equal(reopened.acceptInbound("decision-1", 1, { type: "decision" }), false);
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("dispatches a remote session command once and redacts its processed Inbox payload", async () => {
  const directory = await mkdtemp(join(tmpdir(), "yurupager-command-inbox-"));
  const path = join(directory, "transport.sqlite");
  const store = new SqliteMessageStore(path);
  const port = await getFreePort();
  const server = new WebSocketServer({ host: "127.0.0.1", port });
  const commandHandled = new Promise<void>((resolve) => {
    server.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (message.type === "hello") {
          socket.send(JSON.stringify({ type: "welcome", connectionEpoch: "server", lastAcceptedSequence: 0 }));
          socket.send(JSON.stringify({
            type: "session.command",
            messageId: "remote-command-message",
            sequence: 9,
            commandId: "remote-command",
            threadId: "thread-real",
            text: "Continue the focused task.",
            attachments: [{
              attachmentId: "attachment-command",
              mimeType: "image/png",
              byteLength: 128,
              sha256: "a".repeat(64),
              path: "/PRIVATE/original-name.png",
              data: "PRIVATE_IMAGE_BYTES",
            }],
          }));
        }
        if (message.type === "ack" && message.messageId === "remote-command-message") resolve();
      });
    });
  });
  const client = new ConnectorCloudClient({
    url: `ws://127.0.0.1:${port}`,
    token: "test-token",
    store,
    reconnectMinMs: 10,
  });
  let handled = 0;
  client.onCommand(async (command) => {
    handled += 1;
    assert.equal(command.text, "Continue the focused task.");
    assert.deepEqual(command.attachments, [{
      attachmentId: "attachment-command",
      mimeType: "image/png",
      byteLength: 128,
      sha256: "a".repeat(64),
    }]);
    assert.equal(JSON.stringify(command).includes("PRIVATE"), false);
  });

  try {
    client.start();
    await withTimeout(commandHandled, 2_000);
    assert.equal(handled, 1);
    const inspection = new DatabaseSync(path, { readOnly: true });
    try {
      const row = inspection.prepare(
        "SELECT payload_json, processed_at FROM transport_inbox WHERE message_id = ?",
      ).get("remote-command-message") as { payload_json: string; processed_at: string | null };
      assert.equal(row.payload_json, '{"redacted":true}');
      assert.ok(row.processed_at);
    } finally {
      inspection.close();
    }
  } finally {
    await client.stop();
    await closeServer(server);
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("does not ACK a duplicate reliable command while its first delivery is still processing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "yurupager-command-inflight-"));
  const path = join(directory, "transport.sqlite");
  const store = new SqliteMessageStore(path);
  const port = await getFreePort();
  const server = new WebSocketServer({ host: "127.0.0.1", port });
  const command = {
    type: "session.command",
    messageId: "command-inflight-message",
    sequence: 10,
    commandId: "command-inflight",
    threadId: "thread-inflight",
    text: "Wait for the local delivery boundary.",
    attachments: [],
  };
  let acknowledgements = 0;
  let releaseHandler: () => void = () => undefined;
  const handlerGate = new Promise<void>((resolve) => { releaseHandler = resolve; });
  let signalHandlerStarted: () => void = () => undefined;
  const handlerStarted = new Promise<void>((resolve) => { signalHandlerStarted = resolve; });
  let signalAcknowledged: () => void = () => undefined;
  const acknowledged = new Promise<void>((resolve) => { signalAcknowledged = resolve; });
  server.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (message.type === "hello") {
        socket.send(JSON.stringify({ type: "welcome", connectionEpoch: "server", lastAcceptedSequence: 0 }));
        socket.send(JSON.stringify(command));
        socket.send(JSON.stringify(command));
      } else if (message.type === "ack" && message.messageId === command.messageId) {
        acknowledgements += 1;
        signalAcknowledged();
      }
    });
  });
  const client = new ConnectorCloudClient({
    url: `ws://127.0.0.1:${port}`,
    token: "test-token",
    store,
    reconnectMinMs: 10,
  });
  let handled = 0;
  client.onCommand(async () => {
    handled += 1;
    signalHandlerStarted();
    await handlerGate;
  });

  try {
    client.start();
    await withTimeout(handlerStarted, 2_000);
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    assert.equal(acknowledgements, 0);
    assert.equal(handled, 1);
    releaseHandler();
    await withTimeout(acknowledged, 2_000);
    assert.equal(acknowledgements, 1);
    assert.equal(handled, 1);
  } finally {
    await client.stop();
    await closeServer(server);
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("routes conversation controls and frames without touching SQLite Inbox or Outbox", async () => {
  const directory = await mkdtemp(join(tmpdir(), "yurupager-stream-"));
  const path = join(directory, "transport.sqlite");
  const store = new SqliteMessageStore(path);
  const port = await getFreePort();
  const server = new WebSocketServer({ host: "127.0.0.1", port });
  const receivedFrame = new Promise<Record<string, unknown>>((resolve) => {
    server.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (message.type === "hello") {
          socket.send(JSON.stringify({ type: "welcome", connectionEpoch: "server", lastAcceptedSequence: 0 }));
          socket.send(JSON.stringify({
            type: "session.stream.subscribe",
            subscriptionId: "stream-subscription",
            threadId: "thread-local",
          }));
        } else if (message.type === "session.stream.frame") {
          resolve(message);
        }
      });
    });
  });
  const client = new ConnectorCloudClient({
    url: `ws://127.0.0.1:${port}`,
    token: "test-token",
    store,
    reconnectMinMs: 10,
  });
  client.onSessionStream((control) => {
    assert.equal(control.threadId, "thread-local");
    client.sendEphemeral({
      type: "session.stream.frame",
      subscriptionId: control.subscriptionId,
      threadId: control.threadId,
      frame: { kind: "message.delta", messageId: "agent-local", delta: "仅内存" },
    });
  });

  try {
    client.start();
    const frame = await withTimeout(receivedFrame, 2_000);
    assert.equal((frame.frame as { delta: string }).delta, "仅内存");
    assert.equal(store.pending().length, 0);
    const inspection = new DatabaseSync(path, { readOnly: true });
    try {
      const inbox = inspection.prepare("SELECT count(*) AS count FROM transport_inbox").get() as { count: number };
      const outbox = inspection.prepare("SELECT count(*) AS count FROM transport_outbox").get() as { count: number };
      assert.equal(inbox.count, 0);
      assert.equal(outbox.count, 0);
    } finally {
      inspection.close();
    }
  } finally {
    await client.stop();
    await closeServer(server);
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("routes resumable attachment controls and statuses entirely outside reliable storage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "yurupager-attachment-stream-"));
  const path = join(directory, "transport.sqlite");
  const store = new SqliteMessageStore(path);
  const port = await getFreePort();
  const server = new WebSocketServer({ host: "127.0.0.1", port });
  const sha256 = "a".repeat(64);
  const privateChunk = Buffer.from("PRIVATE_IMAGE_BYTES_SENTINEL").toString("base64");
  const ready = new Promise<void>((resolve) => {
    server.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (message.type === "hello") {
          socket.send(JSON.stringify({ type: "welcome", connectionEpoch: "server", lastAcceptedSequence: 0 }));
          socket.send(JSON.stringify({
            type: "session.attachment.begin",
            transferId: "transfer-image",
            uploadId: "upload-image",
            threadId: "thread-image",
            mimeType: "image/png",
            byteLength: 30,
            sha256,
          }));
        } else if (message.type === "session.attachment.status" && message.state === "accepted") {
          socket.send(JSON.stringify({
            type: "session.attachment.chunk",
            transferId: "transfer-image",
            uploadId: "upload-image",
            offset: 0,
            data: privateChunk,
          }));
        } else if (message.type === "session.attachment.status" && message.state === "progress") {
          socket.send(JSON.stringify({
            type: "session.attachment.complete",
            transferId: "transfer-image",
            uploadId: "upload-image",
          }));
        } else if (message.type === "session.attachment.status" && message.state === "ready") {
          assert.equal(message.attachmentId, "attachment-image");
          resolve();
        }
      });
    });
  });
  const client = new ConnectorCloudClient({
    url: `ws://127.0.0.1:${port}`,
    token: "test-token",
    store,
    reconnectMinMs: 10,
  });
  client.onAttachment((control) => {
    if (control.type === "session.attachment.begin") {
      client.sendAttachmentStatus({
        type: "session.attachment.status",
        transferId: control.transferId,
        uploadId: control.uploadId,
        state: "accepted",
        nextOffset: 0,
      });
    } else if (control.type === "session.attachment.chunk") {
      assert.equal(control.data, privateChunk);
      client.sendAttachmentStatus({
        type: "session.attachment.status",
        transferId: control.transferId,
        uploadId: control.uploadId,
        state: "progress",
        nextOffset: Buffer.from(control.data, "base64").length,
      });
    } else if (control.type === "session.attachment.complete") {
      client.sendAttachmentStatus({
        type: "session.attachment.status",
        transferId: control.transferId,
        uploadId: control.uploadId,
        state: "ready",
        nextOffset: 30,
        attachmentId: "attachment-image",
      });
    }
  });

  try {
    client.start();
    await withTimeout(ready, 2_000);
    const inspection = new DatabaseSync(path, { readOnly: true });
    try {
      const inbox = inspection.prepare("SELECT count(*) AS count FROM transport_inbox").get() as { count: number };
      const outbox = inspection.prepare("SELECT count(*) AS count FROM transport_outbox").get() as { count: number };
      assert.equal(inbox.count, 0);
      assert.equal(outbox.count, 0);
    } finally {
      inspection.close();
    }
  } finally {
    await client.stop();
    await closeServer(server);
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function getFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  return port;
}

async function closeServer(server: WebSocketServer | undefined): Promise<void> {
  if (server === undefined) return;
  for (const client of server.clients) client.terminate();
  await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => setTimeout(() => reject(new Error("Timed out waiting for message")), timeoutMs)),
  ]);
}
