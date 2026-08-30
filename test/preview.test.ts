import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import type {
  ConnectorPreviewRoute,
  PreviewTunnelClientMessage,
  PreviewTunnelServerMessage,
} from "@yurupager/shared";
import { WebSocketServer } from "ws";

import { PreviewTunnelClient } from "../src/preview/client.js";
import { parsePreviewArguments } from "../src/preview/options.js";
import { readPreviewServerMessage } from "../src/preview/protocol.js";
import { PreviewTunnel } from "../src/preview/tunnel.js";

test("preview command accepts only an explicit safe port, label and bounded duration", () => {
  assert.deepEqual(parsePreviewArguments(["5173"]), {
    port: 5173,
    name: "localhost:5173",
    durationMinutes: 60,
  });
  assert.deepEqual(parsePreviewArguments(["65535", "--name", "管理台", "--duration", "240"]), {
    port: 65535,
    name: "管理台",
    durationMinutes: 240,
  });
  for (const args of [
    ["1023"], ["65536"], ["http://localhost:5173"], ["5173", "--duration", "14"],
    ["5173", "--duration", "241"], ["5173", "--name", "bad\nname"], ["5173", "--host", "10.0.0.2"],
  ]) assert.throws(() => parsePreviewArguments(args));
});

test("preview protocol rejects CONNECT, absolute-form paths, CRLF, oversized chunks and bad sequence fields", () => {
  assert.throws(() => readPreviewServerMessage({
    type: "preview.http.open",
    streamId: "stream",
    routeId: "route",
    method: "CONNECT",
    path: "/",
    headers: [],
  }));
  assert.throws(() => readPreviewServerMessage({
    type: "preview.http.open",
    streamId: "stream",
    routeId: "route",
    method: "GET",
    path: "http://internal.example/",
    headers: [],
  }));
  assert.throws(() => readPreviewServerMessage({
    type: "preview.http.open",
    streamId: "stream",
    routeId: "route",
    method: "GET",
    path: "/",
    headers: [["x-test", "ok\r\ninjected: yes"]],
  }));
  assert.throws(() => readPreviewServerMessage({
    type: "preview.http.request.chunk",
    streamId: "stream",
    offset: 0,
    data: Buffer.alloc(32 * 1024 + 1).toString("base64"),
  }));
  assert.throws(() => readPreviewServerMessage({
    type: "preview.ws.frame",
    streamId: "stream",
    sequence: -1,
    binary: false,
    data: Buffer.from("x").toString("base64"),
  }));
});

test("preview tunnel proxies bounded HTTP chunks to fixed loopback and strips authority credentials", async () => {
  let receivedBody = "";
  let receivedHeaders: IncomingHttpHeaders = {};
  const local = createServer((request, response) => {
    receivedHeaders = request.headers;
    request.setEncoding("utf8");
    request.on("data", (chunk) => { receivedBody += chunk; });
    request.on("end", () => {
      response.writeHead(201, { "content-type": "text/plain", "x-local": "yes" });
      response.end("hello world");
    });
  });
  const port = await listen(local);
  const outbound: PreviewTunnelClientMessage[] = [];
  const tunnel = new PreviewTunnel({
    routeId: "route-1",
    target: { host: "127.0.0.1", port },
    maxChunkBytes: 8,
    initialWindowBytes: 8,
    send(message) { outbound.push(message); return true; },
  });

  try {
    tunnel.handle(httpOpen("stream-1", "/submit", "POST", [
      ["x-from-gateway", "yes"],
      ["host", "attacker.invalid"],
      ["origin", "https://attacker.invalid"],
      ["authorization", "Bearer secret"],
    ], 3));
    tunnel.handle({
      type: "preview.http.request.chunk",
      streamId: "stream-1",
      offset: 0,
      data: Buffer.from("abc").toString("base64"),
    });
    tunnel.handle({ type: "preview.http.request.end", streamId: "stream-1" });

    await waitFor(() => outbound.some((message) => message.type === "preview.http.response.chunk"));
    const first = outbound.find((message) => message.type === "preview.http.response.chunk");
    assert.equal(first?.type === "preview.http.response.chunk" ? first.offset : -1, 0);
    tunnel.handle({
      type: "preview.flow",
      streamId: "stream-1",
      direction: "response",
      ackOffset: 8,
      creditBytes: 8,
    });
    await waitFor(() => outbound.some((message) => message.type === "preview.http.response.end"));

    assert.equal(receivedBody, "abc");
    assert.equal(receivedHeaders.host, `127.0.0.1:${port}`);
    assert.equal(receivedHeaders.origin, `http://127.0.0.1:${port}`);
    assert.equal(receivedHeaders.authorization, undefined);
    assert.equal(receivedHeaders["x-from-gateway"], "yes");
    const response = Buffer.concat(outbound
      .filter((message): message is Extract<PreviewTunnelClientMessage, { type: "preview.http.response.chunk" }> =>
        message.type === "preview.http.response.chunk")
      .map((message) => Buffer.from(message.data, "base64"))).toString();
    assert.equal(response, "hello world");
    assert.equal(tunnel.activeStreamCount, 0);
  } finally {
    tunnel.close();
    await close(local);
  }
});

test("preview tunnel rejects out-of-order chunks, enforces concurrency, and times out a slow local response", async () => {
  const local = createServer((_request, _response) => undefined);
  const port = await listen(local);
  const outbound: PreviewTunnelClientMessage[] = [];
  const tunnel = new PreviewTunnel({
    routeId: "route-1",
    target: { host: "127.0.0.1", port },
    maxChunkBytes: 32 * 1024,
    initialWindowBytes: 256 * 1024,
    firstByteTimeoutMs: 30,
    idleTimeoutMs: 1_000,
    maxLifetimeMs: 1_000,
    send(message) { outbound.push(message); return true; },
  });
  try {
    tunnel.handle(httpOpen("bad-order", "/", "POST", [], 1));
    tunnel.handle({
      type: "preview.http.request.chunk",
      streamId: "bad-order",
      offset: 1,
      data: Buffer.from("x").toString("base64"),
    });
    assert.ok(outbound.some((message) =>
      message.type === "preview.stream.error" && message.streamId === "bad-order" && message.code === "protocol_error"));

    for (let index = 0; index < 32; index += 1) {
      tunnel.handle(httpOpen(`hold-${index}`, "/", "GET", []));
      tunnel.handle({ type: "preview.http.request.end", streamId: `hold-${index}` });
    }
    tunnel.handle(httpOpen("overflow", "/", "GET", []));
    assert.ok(outbound.some((message) =>
      message.type === "preview.stream.error" && message.streamId === "overflow" && message.code === "protocol_error"));
    await waitFor(() => outbound.some((message) =>
      message.type === "preview.stream.error" && message.streamId === "hold-0" && message.code === "local_timeout"));
  } finally {
    tunnel.close();
    await close(local);
  }
});

test("preview WebSocket frames preserve order and remain on the pinned loopback authority", async () => {
  const local = createServer();
  const localWebSocket = new WebSocketServer({ server: local });
  let upgradeHeaders: IncomingHttpHeaders = {};
  localWebSocket.on("connection", (socket, request) => {
    upgradeHeaders = request.headers;
    socket.on("message", (data, binary) => socket.send(data, { binary }));
  });
  const port = await listen(local);
  const outbound: PreviewTunnelClientMessage[] = [];
  const tunnel = new PreviewTunnel({
    routeId: "route-1",
    target: { host: "127.0.0.1", port },
    maxChunkBytes: 32 * 1024,
    initialWindowBytes: 256 * 1024,
    send(message) { outbound.push(message); return true; },
  });
  try {
    tunnel.handle({
      type: "preview.ws.open",
      streamId: "ws-1",
      routeId: "route-1",
      path: "/hmr",
      headers: [["authorization", "Bearer must-not-reach-loopback"]],
      protocols: [],
    });
    await waitFor(() => outbound.some((message) => message.type === "preview.ws.accepted"));
    tunnel.handle({
      type: "preview.ws.frame",
      streamId: "ws-1",
      sequence: 0,
      binary: false,
      data: Buffer.from("hmr-update").toString("base64"),
    });
    await waitFor(() => outbound.some((message) => message.type === "preview.ws.frame"));
    const echoed = outbound.find((message): message is Extract<PreviewTunnelClientMessage, { type: "preview.ws.frame" }> =>
      message.type === "preview.ws.frame");
    assert.equal(echoed?.sequence, 0);
    assert.equal(echoed === undefined ? "" : Buffer.from(echoed.data, "base64").toString(), "hmr-update");
    assert.equal(upgradeHeaders.host, `127.0.0.1:${port}`);
    assert.equal(upgradeHeaders.origin, undefined);
    assert.equal(upgradeHeaders.authorization, undefined);
    tunnel.handle({ type: "preview.ws.close", streamId: "ws-1", code: 1000, reason: "done" });
    await waitFor(() => tunnel.activeStreamCount === 0);
  } finally {
    tunnel.close();
    localWebSocket.close();
    await close(local);
  }
});

test("preview tunnel cancels a WebSocket before the local handshake without crashing the Connector", async () => {
  const local = createServer((_request, _response) => undefined);
  const port = await listen(local);
  const outbound: PreviewTunnelClientMessage[] = [];
  const tunnel = new PreviewTunnel({
    routeId: "route-1",
    target: { host: "127.0.0.1", port },
    maxChunkBytes: 32 * 1024,
    initialWindowBytes: 256 * 1024,
    firstByteTimeoutMs: 1_000,
    send(message) { outbound.push(message); return true; },
  });
  try {
    tunnel.handle({
      type: "preview.ws.open",
      streamId: "ws-cancel-before-open",
      routeId: "route-1",
      path: "/hmr",
      headers: [],
      protocols: ["vite-hmr"],
    });
    await waitFor(() => tunnel.activeStreamCount === 1);
    tunnel.handle({
      type: "preview.stream.cancel",
      streamId: "ws-cancel-before-open",
      reason: "stream_cancelled",
    });
    await waitFor(() => tunnel.activeStreamCount === 0);
    assert.equal(outbound.length, 0);
  } finally {
    tunnel.close();
    await close(local);
  }
});

test("preview cloud client authenticates with the paired token and keeps epoch and route stable across reconnect", async () => {
  const cloud = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => cloud.once("listening", resolve));
  const port = (cloud.address() as AddressInfo).port;
  const hellos: Array<{ authorization: string | undefined; value: unknown }> = [];
  let connections = 0;
  cloud.on("connection", (socket, request) => {
    connections += 1;
    socket.once("message", (raw) => {
      hellos.push({ authorization: request.headers.authorization, value: JSON.parse(raw.toString()) as unknown });
      socket.send(JSON.stringify({
        type: "preview.welcome",
        connectionEpoch: `server-${connections}`,
        maxChunkBytes: 32 * 1024,
        initialWindowBytes: 256 * 1024,
      }));
      if (connections === 1) socket.close(1012, "restart");
    });
  });
  const route: ConnectorPreviewRoute = {
    routeId: "route-stable",
    name: "Vite",
    port: 5173,
    status: "active",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  const client = new PreviewTunnelClient({
    url: `ws://127.0.0.1:${port}`,
    token: "dynamic-paired-token",
    route,
    target: { host: "127.0.0.1", port: 5173 },
    reconnectMinMs: 5,
    reconnectMaxMs: 5,
    random: () => 0.5,
  });
  try {
    client.start();
    await waitFor(() => hellos.length === 2);
    const first = hellos[0]?.value as { connectionEpoch?: string; routes?: ConnectorPreviewRoute[] };
    const second = hellos[1]?.value as { connectionEpoch?: string; routes?: ConnectorPreviewRoute[] };
    assert.equal(hellos[0]?.authorization, "Bearer dynamic-paired-token");
    assert.equal(first.connectionEpoch, second.connectionEpoch);
    assert.deepEqual(first.routes, [route]);
    assert.deepEqual(second.routes, [route]);
  } finally {
    await client.stop();
    await new Promise<void>((resolve) => cloud.close(() => resolve()));
  }
});

function httpOpen(
  streamId: string,
  path: string,
  method: "GET" | "POST",
  headers: Array<[string, string]>,
  bodyLength?: number,
): Exclude<PreviewTunnelServerMessage, { type: "preview.welcome" | "preview.route.stop" }> {
  return bodyLength === undefined
    ? { type: "preview.http.open", streamId, routeId: "route-1", method, path, headers }
    : { type: "preview.http.open", streamId, routeId: "route-1", method, path, headers, bodyLength };
}

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  return (server.address() as AddressInfo).port;
}

async function close(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for preview state");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
