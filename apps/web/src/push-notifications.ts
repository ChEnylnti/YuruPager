import type { PushCapability, PushSubscriptionInput } from "@yurupager/shared";

import {
  getPushCapability,
  registerPushSubscription,
  unregisterPushSubscription,
} from "./api.js";
import { pushNotificationsText } from "./i18n.js";

export type PushNotificationState =
  | { kind: "loading" }
  | { kind: "unsupported" }
  | { kind: "server_disabled" }
  | { kind: "available"; permission: NotificationPermission }
  | { kind: "denied" }
  | { kind: "subscribed" }
  | { kind: "error"; message: string; subscribed: boolean };

export async function inspectPushNotifications(): Promise<PushNotificationState> {
  const capability = await getPushCapability();
  if (!capability.enabled || capability.publicKey === null) return { kind: "server_disabled" };
  if (!supportsPushNotifications()) return { kind: "unsupported" };
  const subscription = await currentSubscription();
  if (subscription !== null) {
    await registerPushSubscription(serializeSubscription(subscription));
    return { kind: "subscribed" };
  }
  return Notification.permission === "denied"
    ? { kind: "denied" }
    : { kind: "available", permission: Notification.permission };
}

export async function enablePushNotifications(): Promise<PushNotificationState> {
  const capability = await getPushCapability();
  assertCapability(capability);
  if (!supportsPushNotifications()) return { kind: "unsupported" };
  const permission = Notification.permission === "granted"
    ? "granted"
    : await Notification.requestPermission();
  if (permission === "denied") return { kind: "denied" };
  if (permission !== "granted") return { kind: "available", permission };

  const registration = await readyServiceWorker();
  const existing = await registration.pushManager.getSubscription();
  const subscription = existing ?? await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: decodeApplicationServerKey(capability.publicKey!),
  });
  try {
    await registerPushSubscription(serializeSubscription(subscription));
    return { kind: "subscribed" };
  } catch (error) {
    if (existing === null) await subscription.unsubscribe().catch(() => false);
    throw error;
  }
}

export async function disablePushNotifications(): Promise<PushNotificationState> {
  if (!supportsPushNotifications()) return { kind: "unsupported" };
  const subscription = await currentSubscription();
  if (subscription === null) {
    return Notification.permission === "denied"
      ? { kind: "denied" }
      : { kind: "available", permission: Notification.permission };
  }
  await unregisterPushSubscription(subscription.endpoint);
  const removed = await subscription.unsubscribe();
  if (!removed) throw new Error(pushNotificationsText.unsubscribeFailed);
  return Notification.permission === "denied"
    ? { kind: "denied" }
    : { kind: "available", permission: Notification.permission };
}

export function serializeSubscription(subscription: PushSubscription): PushSubscriptionInput {
  const p256dh = subscription.getKey("p256dh");
  const auth = subscription.getKey("auth");
  if (p256dh === null || auth === null) throw new Error(pushNotificationsText.keysIncomplete);
  return {
    endpoint: subscription.endpoint,
    expirationTime: subscription.expirationTime,
    keys: {
      p256dh: encodeBase64Url(p256dh),
      auth: encodeBase64Url(auth),
    },
  };
}

function supportsPushNotifications(): boolean {
  return window.isSecureContext &&
    "Notification" in window &&
    "serviceWorker" in navigator &&
    "PushManager" in window;
}

async function currentSubscription(): Promise<PushSubscription | null> {
  return (await readyServiceWorker()).pushManager.getSubscription();
}

async function readyServiceWorker(): Promise<ServiceWorkerRegistration> {
  return new Promise<ServiceWorkerRegistration>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(pushNotificationsText.workerNotReady)), 8_000);
    void navigator.serviceWorker.ready.then((registration) => {
      clearTimeout(timer);
      resolve(registration);
    }, (error: unknown) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function assertCapability(capability: PushCapability): void {
  if (!capability.enabled || capability.publicKey === null) {
    throw new Error(pushNotificationsText.serverDisabled);
  }
}

function decodeApplicationServerKey(value: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - value.length % 4) % 4);
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/") + padding);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function encodeBase64Url(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
