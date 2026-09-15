import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { SessionSummary, Snapshot } from "@yurupager/shared";

import { groupSessionsByProject, SessionsView } from "../src/views.js";
import type { LiveChannel } from "../src/live-channel.js";

const baseSession: SessionSummary = {
  id: "session-one",
  workspaceId: "workspace-one",
  workstationId: "workstation-one",
  workstationName: "Levinthal MacBook Pro",
  initiatorName: "Alice Chen",
  threadId: "019fcbee-818e-7310-8ebc-415f53d62945",
  projectKey: "project-trace-agent",
  projectName: "trace-agent",
  projectPath: "~/Documents/trace-agent",
  model: "gpt-5.6-codex",
  status: "waiting",
  syncState: "live",
  startedAt: "2026-08-09T08:00:00.000Z",
  updatedAt: "2026-08-09T08:05:00.000Z",
};

describe("session project index", () => {
  it("keeps loose sessions last even when they are newer than projects", () => {
    const groups = groupSessionsByProject([
      { ...baseSession, id: "loose", projectKey: "outside", projectName: "项目外会话", updatedAt: "2026-08-10T09:05:00.000Z" },
      baseSession,
    ]);
    expect(groups.map((group) => group.name)).toEqual(["trace-agent", "项目外会话"]);
  });
  it("groups by workstation and opaque project key while preserving recency", () => {
    const sessions = [
      baseSession,
      { ...baseSession, id: "session-two", threadId: "thread-two", updatedAt: "2026-08-09T09:05:00.000Z" },
      { ...baseSession, id: "session-three", threadId: "thread-three", projectKey: "another-path", projectPath: "~/Archive/trace-agent" },
    ];
    const groups = groupSessionsByProject(sessions);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.sessions.map((session) => session.id)).toEqual(["session-two", "session-one"]);
    expect(groups[1]?.path).toBe("~/Archive/trace-agent");
  });

  it("uses an accessible project toggle without treating it as a conversation", () => {
    const channel: LiveChannel = { send: vi.fn(() => true), subscribe: vi.fn(() => () => undefined) };
    const snapshot: Snapshot = {
      generatedAt: "2026-08-09T09:10:00.000Z",
      scopeWorkspaceId: "workspace-one",
      workspaces: [{ id: "workspace-one", name: "Yuru Systems", slug: "yuru", kind: "team", role: "owner", pendingCount: 0 }],
      workstations: [{ id: "workstation-one", workspaceId: "workspace-one", workspaceName: "Yuru Systems", name: "Levinthal MacBook Pro", platform: "macOS", connectorVersion: "0.2.0-alpha", status: "online", lastSeenAt: "2026-08-09T09:09:00.000Z", activeSessionCount: 1, pendingCount: 0 }],
      previews: [],
      previewCapability: { enabled: false, gatewayOrigin: null, command: "yurupager preview <port>" },
      sessions: [baseSession],
      sessionCommands: [],
      requests: [],
      members: [],
      usage: [],
      audit: [],
    };
    const props = { snapshot, selectedId: baseSession.id, mobileDetail: false, online: true, liveChannel: channel, onSelect: vi.fn(), onBack: vi.fn(), onCommandChange: vi.fn(), onToast: vi.fn() };
    const view = render(<SessionsView {...props} sessionTitles={{}} />);

    const project = screen.getByRole("button", { name: /trace-agent/ });
    expect(project).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: /Codex 会话 019fcbee/ })).toBeVisible();
    view.rerender(<SessionsView {...props} sessionTitles={{ [baseSession.id]: "创建私人仓库并提交项目" }} />);
    const titledSession = screen.getByRole("button", { name: /创建私人仓库并提交项目/ });
    expect(titledSession).toBeVisible();
    expect(within(titledSession).getByText("等待处理")).toBeVisible();
    fireEvent.click(project);
    expect(project).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: /创建私人仓库并提交项目/ })).not.toBeInTheDocument();
  });
});
