import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { WorkflowCanvas } from "../src/workflow-canvas.js";
import type { Snapshot } from "@yurupager/shared";

describe("WorkflowCanvas smoke", () => {
  it("renders without throwing", () => {
    const snapshot = {
      scopeWorkspaceId: null,
      workstations: [{
        id: "ws-1", workspaceId: "ws-a", workspaceName: "W", name: "N",
        platform: "p", connectorVersion: "v", status: "online" as const,
        lastSeenAt: null, activeSessionCount: 0, pendingCount: 0,
      }],
      sessions: [],
    } as unknown as Snapshot;
    const { container } = render(<WorkflowCanvas snapshot={snapshot} onToast={() => undefined} />);
    expect(container.textContent).toContain("工作流");
  });
});
