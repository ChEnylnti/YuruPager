import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

const WEB_SOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export interface TestWebSocketServer {
  url: string;
  close(): Promise<void>;
}

export async function startWebSocketJsonRpcServer(): Promise<TestWebSocketServer> {
  const sockets = new Set<Duplex>();
  const server = createServer();
  server.on("upgrade", (request, socket, head) => {
    const key = request.headers["sec-websocket-key"];
    if (typeof key !== "string") {
      socket.destroy();
      return;
    }

    const accept = createHash("sha1")
      .update(`${key}${WEB_SOCKET_GUID}`)
      .digest("base64");
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "",
        "",
      ].join("\r\n"),
    );
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));

    let buffered: Buffer = Buffer.from(head);
    socket.on("data", (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const parsed = parseFrames(buffered);
      buffered = parsed.remaining;
      for (const frame of parsed.frames) {
        if (frame.opcode === 0x8) {
          socket.write(encodeFrame(frame.payload, 0x8));
          socket.end();
        } else if (frame.opcode === 0x9) {
          socket.write(encodeFrame(frame.payload, 0xa));
        } else if (frame.opcode === 0x1) {
          handleJsonRpcMessage(socket, frame.payload.toString("utf8"));
        }
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;

  return {
    url: `ws://127.0.0.1:${String(address.port)}`,
    async close() {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) =>
          error === undefined ? resolve() : reject(error),
        );
      });
    },
  };
}

function handleJsonRpcMessage(socket: Duplex, serialized: string): void {
  const message = JSON.parse(serialized) as Record<string, unknown>;
  if (message.method === "initialize") {
    sendJson(socket, {
      id: message.id,
      result: {
        codexHome: "/tmp/test-codex",
        platformFamily: "unix",
        platformOs: "test-ws",
        userAgent: "mock-websocket-server",
      },
    });
  } else if (message.method === "echo") {
    sendJson(socket, { id: message.id, result: message.params });
    sendJson(socket, {
      id: "approval-1",
      method: "mock/approval",
      params: { command: "mock" },
    });
  } else if (message.id === "approval-1") {
    sendJson(socket, {
      method: "mock/responseObserved",
      params: { response: message.result },
    });
  }
}

function sendJson(socket: Duplex, message: Record<string, unknown>): void {
  socket.write(encodeFrame(Buffer.from(JSON.stringify(message), "utf8"), 0x1));
}

interface ParsedFrame {
  opcode: number;
  payload: Buffer;
}

function parseFrames(buffer: Buffer): {
  frames: ParsedFrame[];
  remaining: Buffer;
} {
  const frames: ParsedFrame[] = [];
  let cursor = 0;

  while (buffer.length - cursor >= 2) {
    const first = buffer[cursor];
    const second = buffer[cursor + 1];
    if (first === undefined || second === undefined) {
      break;
    }
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let payloadLength = second & 0x7f;
    let headerLength = 2;

    if (payloadLength === 126) {
      if (buffer.length - cursor < 4) {
        break;
      }
      payloadLength = buffer.readUInt16BE(cursor + 2);
      headerLength = 4;
    } else if (payloadLength === 127) {
      if (buffer.length - cursor < 10) {
        break;
      }
      const length = buffer.readBigUInt64BE(cursor + 2);
      if (length > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error("Test WebSocket frame is too large");
      }
      payloadLength = Number(length);
      headerLength = 10;
    }

    const maskLength = masked ? 4 : 0;
    const frameLength = headerLength + maskLength + payloadLength;
    if (buffer.length - cursor < frameLength) {
      break;
    }

    const maskOffset = cursor + headerLength;
    const payloadOffset = maskOffset + maskLength;
    const payload = Buffer.from(
      buffer.subarray(payloadOffset, payloadOffset + payloadLength),
    );
    if (masked) {
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] = payload[index]! ^ buffer[maskOffset + (index % 4)]!;
      }
    }
    frames.push({ opcode, payload });
    cursor += frameLength;
  }

  return { frames, remaining: buffer.subarray(cursor) };
}

function encodeFrame(payload: Buffer, opcode: number): Buffer {
  let header: Buffer;
  if (payload.length < 126) {
    header = Buffer.from([0x80 | opcode, payload.length]);
  } else if (payload.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([header, payload]);
}
