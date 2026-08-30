import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  disablePushNotifications,
  enablePushNotifications,
  inspectPushNotifications,
} from "../src/push-notifications.js";
import { PushNotificationMenu } from "../src/push-notification-menu.js";

vi.mock("../src/push-notifications.js", () => ({
  disablePushNotifications: vi.fn(),
  enablePushNotifications: vi.fn(),
  inspectPushNotifications: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(inspectPushNotifications).mockReset().mockResolvedValue({ kind: "available", permission: "default" });
  vi.mocked(enablePushNotifications).mockReset();
  vi.mocked(disablePushNotifications).mockReset();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  });
});

describe("notification settings menu", () => {
  it("keeps one submission in flight and returns focus to the trigger on Escape", async () => {
    let finish: ((value: { kind: "subscribed" }) => void) | undefined;
    vi.mocked(enablePushNotifications).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const toast = vi.fn();
    render(<PushNotificationMenu userId="user-one" onToast={toast} />);
    await waitFor(() => expect(inspectPushNotifications).toHaveBeenCalledTimes(1));

    const trigger = screen.getByRole("button", { name: "通知设置" });
    fireEvent.click(trigger);
    const enable = await screen.findByRole("button", { name: "开启通知" });
    await waitFor(() => expect(enable).toHaveFocus());
    fireEvent.click(enable);
    fireEvent.click(enable);
    expect(enablePushNotifications).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "正在开启" })).toBeDisabled();

    await act(async () => finish?.({ kind: "subscribed" }));
    await waitFor(() => expect(screen.getByText("通知已开启", { selector: "strong" })).toBeVisible());
    expect(toast).toHaveBeenCalledWith("此设备已开启待办通知");

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it("explains denied permission without presenting another enable action", async () => {
    vi.mocked(inspectPushNotifications).mockResolvedValueOnce({ kind: "denied" });
    render(<PushNotificationMenu userId="user-one" onToast={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "通知设置" }));

    expect(await screen.findByText("浏览器已阻止通知")).toBeVisible();
    expect(screen.queryByRole("button", { name: "开启通知" })).not.toBeInTheDocument();
    expect(enablePushNotifications).not.toHaveBeenCalled();
  });
});
