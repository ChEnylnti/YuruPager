import { previewLimits } from "@yurupager/shared";

import type { PreviewAccess } from "./types.js";
import { PreviewAdmissionFailure } from "./types.js";

export interface CapacityEntry {
  access: PreviewAccess;
}

interface StreamLike {
  access: PreviewAccess;
  connector: PreviewAccess["connector"];
}

export interface CapacityOptions {
  isActive(): boolean;
  streams(): Iterable<StreamLike>;
}

/**
 * Owns preview admission control: per-user and per-Connector concurrency
 * caps, bounded queues of waiters, and abortable reservation waits (流控).
 */
export class PreviewCapacity {
  readonly #waiters = new Set<CapacityEntry>();
  readonly #reservations = new Set<CapacityEntry>();

  async reserve(access: PreviewAccess, signal: AbortSignal, options: CapacityOptions): Promise<CapacityEntry> {
    if (!options.isActive()) throw new PreviewAdmissionFailure("unavailable");
    if (this.#hasCapacity(access, options.streams())) {
      const reservation = { access };
      this.#reservations.add(reservation);
      return reservation;
    }

    let userWaiters = 0;
    let connectorWaiters = 0;
    for (const waiter of this.#waiters) {
      if (waiter.access.binding.userId === access.binding.userId) userWaiters += 1;
      if (waiter.access.connector === access.connector) connectorWaiters += 1;
    }
    if (
      userWaiters >= previewLimits.maxQueuedStreamsPerUser ||
      connectorWaiters >= previewLimits.maxQueuedStreamsPerConnector
    ) throw new PreviewAdmissionFailure("busy");

    const waiter = { access };
    const deadline = Date.now() + previewLimits.firstByteTimeoutMs;
    this.#waiters.add(waiter);
    try {
      while (true) {
        if (signal.aborted) throw new PreviewAdmissionFailure("cancelled");
        if (!options.isActive()) throw new PreviewAdmissionFailure("unavailable");
        if (this.#hasCapacity(access, options.streams())) {
          const reservation = { access };
          this.#reservations.add(reservation);
          return reservation;
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new PreviewAdmissionFailure("busy");
        await abortableDelay(Math.min(10, remaining), signal);
      }
    } finally {
      this.#waiters.delete(waiter);
    }
  }

  release(reservation: CapacityEntry): void {
    this.#reservations.delete(reservation);
  }

  #hasCapacity(access: PreviewAccess, streams: Iterable<StreamLike>): boolean {
    let userStreams = 0;
    let connectorStreams = 0;
    for (const stream of streams) {
      if (stream.access.binding.userId === access.binding.userId) userStreams += 1;
      if (stream.connector === access.connector) connectorStreams += 1;
    }
    for (const reservation of this.#reservations) {
      if (reservation.access.binding.userId === access.binding.userId) userStreams += 1;
      if (reservation.access.connector === access.connector) connectorStreams += 1;
    }
    return userStreams < previewLimits.maxConcurrentStreamsPerUser &&
      connectorStreams < previewLimits.maxConcurrentStreamsPerConnector;
  }
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new PreviewAdmissionFailure("cancelled"));
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timeout);
      reject(new PreviewAdmissionFailure("cancelled"));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}
