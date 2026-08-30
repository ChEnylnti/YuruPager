import type { Pool } from "pg";
import webPush, {
  type PushSubscription as WebPushSubscription,
  type RequestOptions,
  type SendResult,
} from "web-push";

import type { PushCapability, PushSubscriptionInput } from "@yurupager/shared";

import type { Config } from "./config.js";
import { HttpError } from "./errors.js";

export interface PushRequestEvent {
  workspaceId: string;
  workstationId: string;
  requestId: string;
  occurredAt: string;
}

export interface PushTransport {
  sendNotification(
    subscription: WebPushSubscription,
    payload: string,
    options: RequestOptions,
  ): Promise<SendResult>;
}

interface StoredSubscription {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  expiration_time: Date | null;
}

const defaultTransport: PushTransport = {
  sendNotification: (subscription, payload, options) =>
    webPush.sendNotification(subscription, payload, options),
};

export class PushService {
  readonly #pool: Pool;
  readonly #config: Config;
  readonly #transport: PushTransport;
  readonly #pending = new Set<Promise<void>>();

  constructor(pool: Pool, config: Config, transport: PushTransport = defaultTransport) {
    this.#pool = pool;
    this.#config = config;
    this.#transport = transport;
  }

  capability(): PushCapability {
    return {
      enabled: this.#config.webPushEnabled,
      publicKey: this.#config.webPushEnabled ? this.#config.webPushVapidPublicKey : null,
    };
  }

  async register(userId: string, input: PushSubscriptionInput): Promise<{ created: boolean }> {
    this.#assertEnabled();
    const subscription = validatePushSubscription(input);
    const result = await this.#pool.query(
      `INSERT INTO push_subscriptions
         (user_id, endpoint, p256dh, auth, expiration_time)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (endpoint) DO UPDATE SET
         user_id = EXCLUDED.user_id,
         p256dh = EXCLUDED.p256dh,
         auth = EXCLUDED.auth,
         expiration_time = EXCLUDED.expiration_time,
         failure_count = 0,
         last_failure_at = NULL,
         last_failure_code = NULL,
         updated_at = now()
       RETURNING (xmax = 0) AS created`,
      [
        userId,
        subscription.endpoint,
        subscription.keys.p256dh,
        subscription.keys.auth,
        subscription.expirationTime === null ? null : new Date(subscription.expirationTime),
      ],
    );
    return { created: result.rows[0]?.created === true };
  }

  async unregister(userId: string, endpoint: string): Promise<void> {
    this.#assertEnabled();
    const validated = validateEndpoint(endpoint);
    await this.#pool.query(
      "DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2",
      [userId, validated],
    );
  }

  enqueueRequest(event: PushRequestEvent): void {
    if (!this.#config.webPushEnabled) return;
    const task = this.#notifyRequest(event)
      .catch(() => undefined)
      .finally(() => this.#pending.delete(task));
    this.#pending.add(task);
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.#pending]);
  }

  async #notifyRequest(event: PushRequestEvent): Promise<void> {
    const subscriptions = await this.#pool.query<StoredSubscription>(
      `SELECT DISTINCT p.id, p.endpoint, p.p256dh, p.auth, p.expiration_time
         FROM push_subscriptions p
         JOIN workspace_members member
           ON member.user_id = p.user_id AND member.workspace_id = $1
        WHERE (p.expiration_time IS NULL OR p.expiration_time > now())
          AND (
            member.role IN ('owner', 'admin')
            OR EXISTS (
              SELECT 1
                FROM workstation_access access
               WHERE access.workspace_id = $1
                 AND access.workstation_id = $2
                 AND access.user_id = p.user_id
                 AND access.can_respond
            )
          )`,
      [event.workspaceId, event.workstationId],
    );
    const payload = JSON.stringify({
      v: 1,
      event: "request.created",
      workspaceId: event.workspaceId,
      requestId: event.requestId,
      occurredAt: event.occurredAt,
    });
    await Promise.all(subscriptions.rows.map((subscription) =>
      this.#send(subscription, payload)));
  }

  async #send(subscription: StoredSubscription, payload: string): Promise<void> {
    try {
      await this.#transport.sendNotification(
        {
          endpoint: subscription.endpoint,
          expirationTime: subscription.expiration_time?.getTime() ?? null,
          keys: { p256dh: subscription.p256dh, auth: subscription.auth },
        },
        payload,
        {
          TTL: 15 * 60,
          urgency: "high",
          vapidDetails: {
            subject: this.#config.webPushVapidSubject!,
            publicKey: this.#config.webPushVapidPublicKey!,
            privateKey: this.#config.webPushVapidPrivateKey!,
          },
        },
      );
      await this.#pool.query(
        `UPDATE push_subscriptions
            SET failure_count = 0, last_success_at = now(), last_failure_at = NULL,
                last_failure_code = NULL, updated_at = now()
          WHERE id = $1`,
        [subscription.id],
      );
    } catch (error) {
      const statusCode = pushStatusCode(error);
      if (statusCode === 404 || statusCode === 410) {
        await this.#pool.query("DELETE FROM push_subscriptions WHERE id = $1", [subscription.id]);
        return;
      }
      await this.#pool.query(
        `UPDATE push_subscriptions
            SET failure_count = failure_count + 1, last_failure_at = now(),
                last_failure_code = $2, updated_at = now()
          WHERE id = $1`,
        [subscription.id, statusCode === null ? "network_error" : `http_${statusCode}`],
      );
    }
  }

  #assertEnabled(): void {
    if (!this.#config.webPushEnabled) {
      throw new HttpError(404, "push_disabled", "Web Push is not configured on this server");
    }
  }
}

export function validatePushSubscription(value: PushSubscriptionInput): PushSubscriptionInput {
  const endpoint = validateEndpoint(value.endpoint);
  if (
    value.expirationTime !== null &&
    (!Number.isSafeInteger(value.expirationTime) ||
      value.expirationTime <= Date.now() ||
      value.expirationTime > 8_640_000_000_000_000)
  ) {
    throw new HttpError(400, "invalid_push_subscription", "Push expirationTime must be null or a future timestamp");
  }
  if (!isBase64Url(value.keys.p256dh, 40, 256) || !isBase64Url(value.keys.auth, 16, 128)) {
    throw new HttpError(400, "invalid_push_subscription", "Push subscription keys are invalid");
  }
  return { endpoint, expirationTime: value.expirationTime, keys: { ...value.keys } };
}

function validateEndpoint(value: string): string {
  if (value.length < 12 || value.length > 2_048 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new HttpError(400, "invalid_push_subscription", "Push endpoint is invalid");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HttpError(400, "invalid_push_subscription", "Push endpoint is invalid");
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.hash !== "") {
    throw new HttpError(400, "invalid_push_subscription", "Push endpoint must use HTTPS without credentials");
  }
  return url.toString();
}

function isBase64Url(value: string, minimum: number, maximum: number): boolean {
  return value.length >= minimum && value.length <= maximum && /^[A-Za-z0-9_-]+$/u.test(value);
}

function pushStatusCode(error: unknown): number | null {
  if (typeof error !== "object" || error === null || !("statusCode" in error)) return null;
  const value = (error as { statusCode?: unknown }).statusCode;
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}
