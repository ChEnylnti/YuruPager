import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getPushCapability,
  registerPushSubscription,
  unregisterPushSubscription,
} from "../src/api.js";
import {
  disablePushNotifications,
  enablePushNotifications,
  inspectPushNotifications,
} from "../src/push-notifications.js";

vi.mock("../src/api.js", () => ({
  getPushCapability: vi.fn(),
  registerPushSubscription: vi.fn(),
  unregisterPushSubscription: vi.fn(),
}));

const publicKey = "B".repeat(87);
const p256dh = Uint8Array.from({ length: 65 }, (_, index) => index + 1).buffer;
const auth = Uint8Array.from({ length: 16 }, (_, index) => index + 10).buffer;

beforeEach(() => {
  vi.mocked(getPushCapability).mockResolvedValue({ enabled: true, publicKey });
  vi.mocked(registerPushSubscription).mockResolvedValue();
  vi.mocked(unregisterPushSubscription).mockResolvedValue();
  Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
  vi.stubGlobal("PushManager", class PushManager {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("PWA Push subscription lifecycle", () => {
  it("restores an existing browser subscription and rebinds it to the signed-in account", async () => {
    const subscription = fakeSubscription();
    installPushRuntime({ permission: "granted", subscription });

    await expect(inspectPushNotifications()).resolves.toEqual({ kind: "subscribed" });
    expect(registerPushSubscription).toHaveBeenCalledWith({
      endpoint: subscription.endpoint,
      expirationTime: null,
      keys: {
        p256dh: encodeExpected(p256dh),
        auth: encodeExpected(auth),
      },
    });
  });

  it("requests permission only during explicit enable and confirms after server registration", async () => {
    const subscription = fakeSubscription();
    const runtime = installPushRuntime({ permission: "default", subscription: null, created: subscription });

    await expect(inspectPushNotifications()).resolves.toEqual({ kind: "available", permission: "default" });
    expect(runtime.requestPermission).not.toHaveBeenCalled();

    await expect(enablePushNotifications()).resolves.toEqual({ kind: "subscribed" });
    expect(runtime.requestPermission).toHaveBeenCalledTimes(1);
    expect(runtime.subscribe).toHaveBeenCalledWith(expect.objectContaining({ userVisibleOnly: true }));
    expect(registerPushSubscription).toHaveBeenCalledTimes(1);
  });

  it("rolls back a newly created browser subscription when server registration fails", async () => {
    const subscription = fakeSubscription();
    installPushRuntime({ permission: "granted", subscription: null, created: subscription });
    vi.mocked(registerPushSubscription).mockRejectedValueOnce(new Error("server unavailable"));

    await expect(enablePushNotifications()).rejects.toThrow("server unavailable");
    expect(subscription.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("keeps the local subscription when server revocation fails", async () => {
    const subscription = fakeSubscription();
    installPushRuntime({ permission: "granted", subscription });
    vi.mocked(unregisterPushSubscription).mockRejectedValueOnce(new Error("offline"));

    await expect(disablePushNotifications()).rejects.toThrow("offline");
    expect(subscription.unsubscribe).not.toHaveBeenCalled();
  });

  it("does not subscribe after the user denies notification permission", async () => {
    const runtime = installPushRuntime({ permission: "denied", subscription: null });

    await expect(enablePushNotifications()).resolves.toEqual({ kind: "denied" });
    expect(runtime.subscribe).not.toHaveBeenCalled();
    expect(registerPushSubscription).not.toHaveBeenCalled();
  });
});

function installPushRuntime(options: {
  permission: NotificationPermission;
  subscription: PushSubscription | null;
  created?: PushSubscription;
  requestResult?: NotificationPermission;
}) {
  let permission = options.permission;
  const requestPermission = vi.fn(async () => {
    permission = options.requestResult ?? (permission === "default" ? "granted" : permission);
    return permission;
  });
  const subscribe = vi.fn(async () => options.created ?? fakeSubscription());
  const getSubscription = vi.fn(async () => options.subscription);
  vi.stubGlobal("Notification", {
    get permission() { return permission; },
    requestPermission,
  });
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: { ready: Promise.resolve({ pushManager: { getSubscription, subscribe } }) },
  });
  return { requestPermission, subscribe, getSubscription, setPermission(value: NotificationPermission) { permission = value; } };
}

function fakeSubscription(): PushSubscription {
  return {
    endpoint: "https://push.example.test/send/device-one",
    expirationTime: null,
    options: { applicationServerKey: null, userVisibleOnly: true },
    getKey: vi.fn((name: PushEncryptionKeyName) => name === "p256dh" ? p256dh : auth),
    toJSON: vi.fn(),
    unsubscribe: vi.fn(async () => true),
  } as unknown as PushSubscription;
}

function encodeExpected(buffer: ArrayBuffer): string {
  return Buffer.from(buffer).toString("base64url");
}
