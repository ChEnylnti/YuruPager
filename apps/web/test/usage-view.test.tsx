import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { Snapshot, UsageSummary } from "@yurupager/shared";

import { UsageView } from "../src/views.js";

const usage: UsageSummary = {
  id: "usage-one",
  workspaceId: "workspace-one",
  workstationId: "workstation-one",
  workstationName: "Levinthal MacBook Pro",
  sessionId: "session-one",
  projectName: "YuruPager",
  model: "gpt-5.6-codex",
  inputTokens: 1_000,
  cachedInputTokens: 200,
  outputTokens: 300,
  reasoningTokens: 100,
  totalTokens: 1_600,
  quality: "final",
  estimatedCostMicros: null,
  priceVersion: null,
  updatedAt: new Date().toISOString(),
};

const snapshot: Snapshot = {
  generatedAt: new Date().toISOString(),
  scopeWorkspaceId: "workspace-one",
  workspaces: [{ id: "workspace-one", name: "Yuru Systems", slug: "yuru", kind: "team", role: "owner", pendingCount: 0 }],
  workstations: [],
  previews: [],
  previewCapability: { enabled: false, gatewayOrigin: null, command: "yurupager preview <port>" },
  sessions: [],
  sessionCommands: [],
  requests: [],
  members: [],
  usage: [usage],
  audit: [],
};

describe("usage cost summary", () => {
  it("does not turn unavailable subscription pricing into a zero-dollar estimate", () => {
    render(<UsageView snapshot={snapshot} />);

    expect(within(screen.getByText("预计成本").parentElement!).getByText("暂无")).toBeVisible();
    expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
  });

  it("marks a mixed priced and unpriced total as only a partial estimate", () => {
    render(<UsageView snapshot={{
      ...snapshot,
      usage: [
        { ...usage, estimatedCostMicros: 500_000, priceVersion: "openai-2026-08" },
        { ...usage, id: "usage-two", sessionId: "session-two" },
      ],
    }} />);

    expect(screen.getByText("$0.50（部分估算）")).toBeVisible();
  });
});
