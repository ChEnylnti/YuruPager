import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";

import type { Config } from "./config.js";
import type { Database } from "./database.js";
import {
  findPairedConnectorIdentity,
  type ConnectorIdentity,
} from "./connector-repository.js";
import type { PreviewRelay } from "./preview-relay.js";

export function registerPreviewConnectorRoute(
  app: FastifyInstance,
  database: Database,
  config: Config,
  relay: PreviewRelay,
): void {
  app.get("/connector/v1/preview/ws", { websocket: true }, (socket, request) => {
    if (!config.previewEnabled) {
      socket.close(4404, "Development preview is disabled");
      return;
    }
    const token = readBearer(request.headers.authorization);
    if (token === null) {
      socket.close(4401, "Invalid connector credential");
      return;
    }
    const pendingMessages: string[] = [];
    let identity: ConnectorIdentity | null = null;
    let authenticated = false;
    let closed = false;
    let processing = Promise.resolve();

    const enqueue = (raw: string) => {
      const activeIdentity = identity;
      if (activeIdentity === null) return;
      processing = processing
        .then(() => relay.handleConnectorMessage(activeIdentity, socket, raw))
        .catch((error: unknown) => {
          app.log.warn(error, "Preview connector message rejected");
          socket.close(4400, "Invalid preview message");
        });
    };

    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        socket.close(4400, "Text preview protocol is required");
        return;
      }
      const raw = data.toString();
      if (!authenticated) {
        if (pendingMessages.length >= 8) {
          socket.close(4408, "Preview authentication is still pending");
          return;
        }
        pendingMessages.push(raw);
        return;
      }
      enqueue(raw);
    });
    socket.on("close", () => {
      closed = true;
      if (identity !== null) {
        void relay.detachConnector(socket).catch((error: unknown) =>
          app.log.warn(error, "Preview connector cleanup failed"));
      }
    });
    socket.on("error", (error) => app.log.warn(error, "Preview connector WebSocket error"));

    void findPairedConnectorIdentity(database.connector, token)
      .then((resolvedIdentity) => {
        if (resolvedIdentity === null) {
          socket.close(4401, "Dynamic connector credential is required");
          return;
        }
        if (closed || socket.readyState !== socket.OPEN) return;
        identity = resolvedIdentity;
        relay.attachConnector(resolvedIdentity, socket as WebSocket);
        authenticated = true;
        for (const raw of pendingMessages.splice(0)) enqueue(raw);
      })
      .catch((error: unknown) => {
        app.log.error(error, "Preview connector authentication failed");
        socket.close(1011, "Preview connector authentication failed");
      });
  });
}

function readBearer(value: string | undefined): string | null {
  return value?.startsWith("Bearer ") === true ? value.slice(7) : null;
}
