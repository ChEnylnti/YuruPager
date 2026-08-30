import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RequestSummary } from "@yurupager/shared";

import { submitDecision } from "../src/api.js";
import { RequestDetail } from "../src/request-detail.js";

vi.mock("../src/api.js", async () => {
  const actual = await vi.importActual<typeof import("../src/api.js")>("../src/api.js");
  return { ...actual, submitDecision: vi.fn() };
});

const request: RequestSummary = {
  id: "50000000-0000-4000-8000-000000000099",
  workspaceId: "20000000-0000-4000-8000-000000000002",
  workspaceName: "Yuru Systems Product Engineering",
  workstationId: "30000000-0000-4000-8000-000000000001",
  workstationName: "Levinthal MacBook Pro",
  sessionId: "40000000-0000-4000-8000-000000000001",
  sessionInitiatorName: "Alice Chen",
  projectName: "YuruPager",
  kind: "approval",
  category: "command",
  tool: "shell",
  risk: "high",
  context: {
    command: "git push origin alpha --force-with-lease",
    cwd: "~/Documents/YuruPager",
    reason: "Update the remote Alpha branch",
  },
  status: "pending",
  deliveryStatus: "not_queued",
  assignedToName: null,
  decidedByName: null,
  decisionReason: null,
  requestedAt: "2026-08-04T09:00:00.000Z",
  expiresAt: "2026-08-04T10:00:00.000Z",
  decidedAt: null,
};

describe("request decision boundary", () => {
  beforeEach(() => vi.mocked(submitDecision).mockReset());

  it("does not submit a high-risk approval until the confirmation action", () => {
    renderDetail();
    fireEvent.click(screen.getByRole("button", { name: "批准" }));
    expect(screen.getByRole("dialog", { name: "确认高风险批准" })).toBeVisible();
    expect(submitDecision).not.toHaveBeenCalled();
  });

  it("returns focus to the approval trigger after cancellation", async () => {
    renderDetail();
    const approve = screen.getByRole("button", { name: "批准" });
    fireEvent.click(approve);
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(approve).toHaveFocus());
  });

  it("submits one explicit high-risk confirmation with an idempotency key", async () => {
    vi.mocked(submitDecision).mockResolvedValue({
      replayed: false,
      request: { ...request, status: "approved", deliveryStatus: "queued", decidedByName: "Alice Chen", decidedAt: "2026-08-04T09:01:00.000Z" },
    });
    renderDetail();
    fireEvent.click(screen.getByRole("button", { name: "批准" }));
    fireEvent.click(screen.getByRole("button", { name: "确认批准" }));
    await waitFor(() => expect(submitDecision).toHaveBeenCalledTimes(1));
    expect(vi.mocked(submitDecision).mock.calls[0]?.[2]).toEqual({
      decision: "approve",
      highRiskConfirmed: true,
    });
    expect(vi.mocked(submitDecision).mock.calls[0]?.[1]).toHaveLength(36);
  });

  it("submits only once when confirmation is double-clicked on a slow network", async () => {
    let resolveDecision: ((value: Awaited<ReturnType<typeof submitDecision>>) => void) | undefined;
    vi.mocked(submitDecision).mockReturnValue(new Promise((resolve) => { resolveDecision = resolve; }));
    renderDetail();
    fireEvent.click(screen.getByRole("button", { name: "批准" }));
    const confirm = screen.getByRole("button", { name: "确认批准" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() => expect(submitDecision).toHaveBeenCalledTimes(1));
    expect(screen.getByText("待处理")).toBeVisible();
    const result = {
      replayed: false,
      request: { ...request, status: "approved", deliveryStatus: "queued", decidedByName: "Alice Chen", decidedAt: "2026-08-04T09:01:00.000Z" },
    } as const;
    resolveDecision?.(result);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("disables every decision while offline", () => {
    renderDetail(false);
    expect(screen.getByRole("button", { name: "批准" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "拒绝" })).toBeDisabled();
    expect(screen.getByText("当前离线。恢复服务器快照前无法提交决定。")).toBeVisible();
  });
});

function renderDetail(online = true) {
  return render(
    <RequestDetail
      request={request}
      online={online}
      onBack={vi.fn()}
      onRequestChange={vi.fn()}
      onToast={vi.fn()}
    />,
  );
}
