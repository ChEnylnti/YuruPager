import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TransitionText } from "../src/transition-text.js";

describe("TransitionText", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0));
    vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
    vi.spyOn(window, "matchMedia").mockReturnValue({ matches: false } as MediaQueryList);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("interrupts an unfinished status swap with the latest value", () => {
    const { rerender } = render(<TransitionText value="等待工作站" />);
    rerender(<TransitionText value="已投递" />);
    expect(screen.getByText("等待工作站")).toHaveClass("is-exit");

    rerender(<TransitionText value="结果未知" />);
    act(() => { vi.advanceTimersByTime(150); });
    expect(screen.getByText("结果未知")).toHaveClass("is-enter-start");
    act(() => { vi.runOnlyPendingTimers(); });
    expect(screen.getByText("结果未知")).not.toHaveClass("is-enter-start");
    expect(screen.queryByText("已投递")).not.toBeInTheDocument();
  });

  it("swaps immediately when reduced motion is requested", () => {
    vi.mocked(window.matchMedia).mockReturnValue({ matches: true } as MediaQueryList);
    const { rerender } = render(<TransitionText value="等待工作站" />);
    rerender(<TransitionText value="已投递" />);
    expect(screen.getByText("已投递")).toBeVisible();
  });
});
