import type { ConnectorSessionTitle, SessionTitle, WebLiveServerMessage } from "@yurupager/shared";

import type { Pool } from "pg";
import type { WebSocket } from "ws";

import type { ConnectorIdentity } from "../connector-repository.js";
import { authorizeSessionTitles } from "../repository.js";
import { connectorKey } from "./connector-links.js";

export interface TitleDirectoryContext {
  pool: Pool;
  /** Live registry of authenticated user sockets, owned by the relay. */
  users: Map<WebSocket, string>;
  sendUser(socket: WebSocket, message: WebLiveServerMessage): void;
}

/**
 * Owns the authoritative `thread.name` snapshots advertised by Connectors and
 * their per-user authorized broadcast. Titles only ever move through live
 * memory; nothing here persists.
 */
export class TitleDirectory {
  readonly #snapshots = new Map<string, { identity: ConnectorIdentity; titles: ConnectorSessionTitle[] }>();
  readonly #context: TitleDirectoryContext;
  #version = 0;

  constructor(context: TitleDirectoryContext) {
    this.#context = context;
  }

  async attach(socket: WebSocket, userId: string): Promise<void> {
    await this.#sendAllTitlesToUser(socket, userId, this.#version);
  }

  take(identity: ConnectorIdentity): boolean {
    return this.#snapshots.delete(connectorKey(identity));
  }

  async ingest(identity: ConnectorIdentity, titles: ConnectorSessionTitle[]): Promise<void> {
    this.#snapshots.set(connectorKey(identity), { identity, titles });
    await this.broadcast();
  }

  async broadcast(): Promise<void> {
    const version = ++this.#version;
    await Promise.all([...this.#context.users].map(([socket, userId]) =>
      this.#sendAllTitlesToUser(socket, userId, version)));
  }

  async #sendAllTitlesToUser(socket: WebSocket, userId: string, version: number): Promise<void> {
    const snapshots = [...this.#snapshots.values()];
    const authorized = await Promise.all(snapshots.map(async ({ identity, titles }) => {
      const byThread = new Map(titles.map((title) => [title.threadId, title.title]));
      const sessions = await authorizeSessionTitles(
        this.#context.pool,
        userId,
        identity.workspaceId,
        identity.workstationId,
        [...byThread.keys()],
      );
      return sessions.flatMap((session): SessionTitle[] => {
        const title = byThread.get(session.threadId);
        return title === undefined ? [] : [{ sessionId: session.sessionId, title }];
      });
    }));
    if (this.#version !== version || this.#context.users.get(socket) !== userId) return;
    const titles = new Map<string, string>();
    for (const batch of authorized) {
      for (const title of batch) titles.set(title.sessionId, title.title);
    }
    this.#context.sendUser(socket, {
      type: "session.titles.snapshot",
      titles: [...titles].map(([sessionId, title]) => ({ sessionId, title })),
    });
  }
}
