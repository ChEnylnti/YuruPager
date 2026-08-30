import type { ConnectorServerMessage } from "@yurupager/shared";

import type { WebSocket } from "ws";

import type { ConnectorIdentity } from "../connector-repository.js";

export type ReliableConnectorMessage = Extract<ConnectorServerMessage, { type: "decision" | "session.command" }>;

interface ConnectorConnection {
  socket: WebSocket;
  phase: "pending" | "active";
  queued: Map<string, ReliableConnectorMessage>;
  sent: Set<string>;
}

export function connectorKey(value: Pick<ConnectorIdentity, "workspaceId" | "workstationId">): string {
  return `${value.workspaceId}:${value.workstationId}`;
}

export function sameConnector(
  route: Pick<ConnectorIdentity, "workspaceId" | "workstationId">,
  identity: ConnectorIdentity,
): boolean {
  return route.workspaceId === identity.workspaceId && route.workstationId === identity.workstationId;
}

export function isOpen(socket: WebSocket): boolean {
  return socket.readyState === socket.OPEN;
}

/**
 * Owns the Connector socket registry: pending/active lifecycle, the reliable
 * outbox queue for messages sent before activation, and per-message
 * de-duplication after replay. Delivery decisions (流控) stay here; message
 * meaning and route bookkeeping stay with the relay.
 */
export class ConnectorLinks {
  readonly #connectors = new Map<string, ConnectorConnection>();

  registerPending(identity: ConnectorIdentity, socket: WebSocket): void {
    this.#connectors.set(connectorKey(identity), { socket, phase: "pending", queued: new Map(), sent: new Set() });
  }

  activate(identity: ConnectorIdentity, socket: WebSocket, replayedMessageIds: ReadonlySet<string>): boolean {
    const connection = this.#connectors.get(connectorKey(identity));
    if (
      connection === undefined ||
      connection.socket !== socket ||
      connection.phase === "active" ||
      !isOpen(socket)
    ) return false;
    connection.phase = "active";
    for (const messageId of replayedMessageIds) connection.sent.add(messageId);

    const queued = [...connection.queued.values()]
      .filter((message) => !replayedMessageIds.has(message.messageId))
      .sort((left, right) => left.sequence - right.sequence);
    connection.queued.clear();
    for (const message of queued) {
      connection.sent.add(message.messageId);
      send(socket, message);
    }
    return true;
  }

  detach(identity: ConnectorIdentity, socket: WebSocket): boolean {
    const key = connectorKey(identity);
    if (this.#connectors.get(key)?.socket !== socket) return false;
    this.#connectors.delete(key);
    return true;
  }

  disconnect(identity: ConnectorIdentity, reason = "Connector disconnected"): void {
    const connection = this.#connectors.get(connectorKey(identity));
    if (connection === undefined) return;
    try {
      connection.socket.close(4003, reason.slice(0, 120));
    } catch {
      connection.socket.terminate();
    }
  }

  activeSocket(identity: Pick<ConnectorIdentity, "workspaceId" | "workstationId">): WebSocket | undefined {
    const connection = this.#connectors.get(connectorKey(identity));
    return connection?.phase === "active" && isOpen(connection.socket) ? connection.socket : undefined;
  }

  pushReliable(identity: ConnectorIdentity, message: ReliableConnectorMessage): boolean {
    const connection = this.#connectors.get(connectorKey(identity));
    if (connection === undefined || !isOpen(connection.socket)) return false;
    if (connection.phase === "pending") {
      connection.queued.set(message.messageId, message);
    } else {
      if (connection.sent.has(message.messageId)) return true;
      connection.sent.add(message.messageId);
      send(connection.socket, message);
    }
    return true;
  }
}

function send(socket: WebSocket, message: ConnectorServerMessage): void {
  if (isOpen(socket)) socket.send(JSON.stringify(message));
}
