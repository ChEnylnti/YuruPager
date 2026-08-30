import type { WebLiveClientMessage, WebLiveServerMessage } from "@yurupager/shared";

export type LiveMessageHandler = (message: WebLiveServerMessage) => void;

export interface LiveChannel {
  send(message: WebLiveClientMessage): boolean;
  subscribe(handler: LiveMessageHandler): () => void;
}
