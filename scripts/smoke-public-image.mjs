import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import WebSocket from "ws";

const baseUrl = requireUrl("YURUPAGER_BASE_URL");
const email = requireEnvironment("YURUPAGER_EMAIL");
const password = requireEnvironment("YURUPAGER_PASSWORD");
const fixturePath = process.env.YURUPAGER_IMAGE_FIXTURE
  ?? resolve(process.cwd(), "apps/web/public/icons/icon-192.png");
const projectName = process.env.YURUPAGER_PROJECT_NAME ?? "YuruPager";

const login = await fetch(new URL("api/auth/login", baseUrl), {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email, password }),
});
if (!login.ok) throw new Error(`Login failed with HTTP ${login.status}`);
const cookie = readSessionCookie(login.headers);

const snapshotResponse = await fetch(new URL("api/snapshot", baseUrl), {
  headers: { cookie },
});
if (!snapshotResponse.ok) throw new Error(`Snapshot failed with HTTP ${snapshotResponse.status}`);
const snapshot = await snapshotResponse.json();
const onlineWorkstations = new Set(
  requireArray(snapshot.workstations, "workstations")
    .filter((workstation) => workstation?.status === "online")
    .map((workstation) => workstation.id),
);
const sessions = requireArray(snapshot.sessions, "sessions");
const session = sessions.find((candidate) =>
  candidate?.projectName === projectName && onlineWorkstations.has(candidate.workstationId))
  ?? sessions.find((candidate) => onlineWorkstations.has(candidate?.workstationId));
if (session === undefined || typeof session.id !== "string") {
  throw new Error("No authorized session with an online Connector is available");
}

const bytes = await readFile(fixturePath);
if (bytes.length === 0 || bytes.length > 48 * 1024) {
  throw new Error("Smoke fixture must fit one non-empty 48 KiB image chunk");
}
const uploadId = randomUUID();
const sha256 = createHash("sha256").update(bytes).digest("hex");
const socketUrl = new URL("api/live", baseUrl);
socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
const socket = new WebSocket(socketUrl, { headers: { cookie } });
const handlers = new Set();
socket.on("message", (data) => {
  let message;
  try { message = JSON.parse(data.toString()); }
  catch { return; }
  for (const handler of handlers) handler(message);
});

try {
  const connected = waitFor((message) => message?.type === "connected", "live connection");
  await waitForOpen(socket);
  await connected;

  const live = waitFor((message) =>
    message?.type === "session.stream.status" &&
    message.sessionId === session.id &&
    message.state === "live", "session stream");
  socket.send(JSON.stringify({ type: "session.stream.subscribe", sessionId: session.id }));
  await live;

  const accepted = waitFor((message) =>
    attachmentStatus(message, session.id, uploadId) &&
    (message.state === "accepted" || message.state === "progress"), "attachment begin");
  socket.send(JSON.stringify({
    type: "session.attachment.begin",
    sessionId: session.id,
    uploadId,
    mimeType: "image/png",
    byteLength: bytes.length,
    sha256,
  }));
  const beginStatus = await accepted;
  if (beginStatus.nextOffset !== 0) throw new Error("New attachment did not start at offset zero");

  const progressed = waitFor((message) =>
    attachmentStatus(message, session.id, uploadId) &&
    message.state === "progress", "attachment chunk");
  socket.send(JSON.stringify({
    type: "session.attachment.chunk",
    sessionId: session.id,
    uploadId,
    offset: 0,
    data: bytes.toString("base64"),
  }));
  const progressStatus = await progressed;
  if (progressStatus.nextOffset !== bytes.length) throw new Error("Attachment ACK offset is incorrect");

  const cancelled = waitFor((message) =>
    attachmentStatus(message, session.id, uploadId) &&
    message.state === "cancelled", "attachment cancellation");
  socket.send(JSON.stringify({
    type: "session.attachment.cancel",
    sessionId: session.id,
    uploadId,
  }));
  await cancelled;

  process.stdout.write(`${JSON.stringify({
    status: "ok",
    sessionId: session.id,
    workstationId: session.workstationId,
    transferredBytes: bytes.length,
    finalState: "cancelled",
  })}\n`);
} finally {
  handlers.clear();
  socket.close();
}

function waitFor(predicate, label, timeoutMs = 20_000) {
  return new Promise((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => {
      handlers.delete(handler);
      rejectPromise(new Error(`Timed out waiting for ${label}`));
    }, timeoutMs);
    const handler = (message) => {
      if (!predicate(message)) return;
      clearTimeout(timeout);
      handlers.delete(handler);
      resolvePromise(message);
    };
    handlers.add(handler);
  });
}

function waitForOpen(socketValue) {
  if (socketValue.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolvePromise, rejectPromise) => {
    socketValue.once("open", resolvePromise);
    socketValue.once("error", rejectPromise);
  });
}

function attachmentStatus(message, sessionId, uploadId) {
  return message?.type === "session.attachment.status" &&
    message.sessionId === sessionId && message.uploadId === uploadId;
}

function readSessionCookie(headers) {
  const value = headers.getSetCookie?.()[0] ?? headers.get("set-cookie");
  if (typeof value !== "string" || !value.includes("=")) {
    throw new Error("Login response did not include a session cookie");
  }
  return value.split(";", 1)[0];
}

function requireArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`Snapshot ${label} is invalid`);
  return value;
}

function requireEnvironment(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function requireUrl(name) {
  const url = new URL(requireEnvironment(name));
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`${name} must use HTTP or HTTPS`);
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}
