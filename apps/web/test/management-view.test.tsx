import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MemberSummary, Snapshot } from "@yurupager/shared";

import { MembersView } from "../src/views.js";

const managementApi = vi.hoisted(() => ({
  createWorkspaceInvite: vi.fn(),
  updateMemberRole: vi.fn(),
  removeMember: vi.fn(),
  revokeWorkstation: vi.fn(),
  updateWorkstationAccess: vi.fn(),
}));

vi.mock("../src/api.js", () => managementApi);

beforeEach(() => {
  for (const mock of Object.values(managementApi)) mock.mockReset();
  managementApi.createWorkspaceInvite.mockResolvedValue({
    workspaceId: "workspace-one",
    workspaceName: "Yuru Systems",
    role: "member",
    token: "ypi_test_invite_token_123456789012345678901234567890123",
    expiresAt: "2026-08-20T00:00:00.000Z",
    replayed: false,
  });
  managementApi.updateMemberRole.mockResolvedValue({ member: member("member", "admin"), replayed: false });
  managementApi.removeMember.mockResolvedValue(undefined);
});

describe("workspace management view", () => {
  it("requires explicit invite and role submissions, then refreshes the snapshot", async () => {
    const onChanged = vi.fn();
    const onToast = vi.fn();
    render(<MembersView snapshot={ownerSnapshot()} onChanged={onChanged} onToast={onToast} />);

    fireEvent.click(screen.getByRole("button", { name: "创建邀请" }));
    await waitFor(() => expect(managementApi.createWorkspaceInvite).toHaveBeenCalledTimes(1));
    expect(managementApi.createWorkspaceInvite.mock.calls[0]?.[0]).toBe("workspace-one");
    expect(managementApi.createWorkspaceInvite.mock.calls[0]?.[1]).toBe("member");
    expect(screen.getByText(/ypi_test_invite_token/)).toBeVisible();

    fireEvent.change(screen.getByRole("combobox", { name: "成员角色：Bob Lin" }), { target: { value: "admin" } });
    await waitFor(() => expect(managementApi.updateMemberRole).toHaveBeenCalledWith("workspace-one", "user-two", "admin"));
    expect(onChanged).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "移除" }));
    expect(managementApi.removeMember).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认移除" }));
    await waitFor(() => expect(managementApi.removeMember).toHaveBeenCalledWith("workspace-one", "user-two"));
  });

  it("keeps member accounts read-only and hides management submissions", () => {
    const snapshot = ownerSnapshot();
    snapshot.workspaces = [{ ...snapshot.workspaces[0]!, role: "member" }];
    render(<MembersView snapshot={snapshot} onChanged={vi.fn()} onToast={vi.fn()} />);

    expect(screen.queryByRole("button", { name: "创建邀请" })).not.toBeInTheDocument();
    expect(screen.getAllByText("只读").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "移除" })).not.toBeInTheDocument();
  });
});

function ownerSnapshot(): Snapshot {
  return {
    generatedAt: new Date().toISOString(),
    scopeWorkspaceId: "workspace-one",
    workspaces: [{ id: "workspace-one", name: "Yuru Systems", slug: "yuru", kind: "company", role: "owner", pendingCount: 0 }],
    workstations: [],
    previews: [],
    previewCapability: { enabled: false, gatewayOrigin: null, command: "yurupager preview <port>" },
    sessions: [],
    sessionCommands: [],
    requests: [],
    members: [member("owner", "owner"), member("member", "member")],
    usage: [],
    audit: [],
  };
}

function member(userId: "owner" | "member", role: MemberSummary["role"]): MemberSummary {
  return {
    id: `membership-${userId}`,
    workspaceId: "workspace-one",
    userId: userId === "owner" ? "user-one" : "user-two",
    name: userId === "owner" ? "Alice Chen" : "Bob Lin",
    email: userId === "owner" ? "alice@example.test" : "bob@example.test",
    role,
    workstationCount: 0,
    workstationAccess: [],
  };
}
