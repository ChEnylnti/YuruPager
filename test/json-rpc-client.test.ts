import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { CodexAppServerClient } from "../src/codex/json-rpc-client.js";
import { startWebSocketJsonRpcServer } from "./helpers/websocket-json-rpc-server.js";

const mockServerPath = fileURLToPath(
  new URL("./fixtures/mock-app-server.js", import.meta.url),
);

test("handles requests, notifications, and server callbacks", async () => {
  const client = new CodexAppServerClient({
    command: process.execPath,
    args: [mockServerPath],
  });
  const observedResponse = new Promise<unknown>((resolve) => {
    client.onNotification((notification) => {
      if (notification.method === "mock/responseObserved") {
        resolve(notification.params);
      }
    });
  });
  client.setServerRequestHandler((request) => {
    assert.equal(request.method, "mock/approval");
    return { decision: "decline" };
  });

  try {
    await client.start();
    const initialized = await client.initialize({
      name: "test-client",
      version: "1.0.0",
    });
    const echo = await client.request("echo", { value: 42 });

    assert.equal(initialized.platformOs, "test");
    assert.deepEqual(echo, { value: 42 });
    assert.deepEqual(await observedResponse, {
      response: { decision: "decline" },
    });
  } finally {
    await client.stop();
  }
});

test("rejects in-flight requests when app-server crashes", async () => {
  const client = new CodexAppServerClient({
    command: process.execPath,
    args: [mockServerPath],
  });

  try {
    await client.start();
    await client.initialize({ name: "test-client", version: "1.0.0" });
    await assert.rejects(
      client.request("crash", {}),
      /app-server exited.*code=17/,
    );
  } finally {
    await client.stop();
  }
});

test("handles requests, notifications, and callbacks over WebSocket", async () => {
  const server = await startWebSocketJsonRpcServer();
  const writtenMethods: string[] = [];
  const client = new CodexAppServerClient({
    webSocketUrl: server.url,
    onServerResponseWritten(request) {
      writtenMethods.push(request.method);
    },
  });
  const observedResponse = new Promise<unknown>((resolve) => {
    client.onNotification((notification) => {
      if (notification.method === "mock/responseObserved") {
        resolve(notification.params);
      }
    });
  });
  client.setServerRequestHandler((request) => {
    assert.equal(request.method, "mock/approval");
    return { decision: "decline" };
  });

  try {
    await client.start();
    const initialized = await client.initialize({
      name: "test-websocket-client",
      version: "1.0.0",
    });
    const echo = await client.request("echo", { value: 42 });

    assert.equal(initialized.platformOs, "test-ws");
    assert.deepEqual(echo, { value: 42 });
    assert.deepEqual(await observedResponse, {
      response: { decision: "decline" },
    });
    assert.deepEqual(writtenMethods, ["mock/approval"]);
  } finally {
    await client.stop();
    await server.close();
  }
});
