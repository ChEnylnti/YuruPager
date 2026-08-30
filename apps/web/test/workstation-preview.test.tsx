import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PreviewCapability, PreviewLaunchResult, WorkstationPreviewSummary } from "@yurupager/shared";

import { WorkstationPreviewSection } from "../src/workstation-preview.js";

const previewApi = vi.hoisted(() => ({
  launchPreview: vi.fn(),
  stopPreview: vi.fn(),
}));

vi.mock("../src/api.js", () => previewApi);

const capability: PreviewCapability = {
  enabled: true,
  gatewayOrigin: "https://preview.example.test",
  command: "yurupager preview <port>",
};

beforeEach(() => {
  previewApi.launchPreview.mockReset();
  previewApi.stopPreview.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("workstation development previews", () => {
  it("filters routes by workstation and renders stable Chinese status and port fields", () => {
    const longName = "A deliberately long Vite development preview name that must not move the numeric port out of view";
    renderSection({
      previews: [makePreview({ name: longName }), makePreview({ id: "other", workstationId: "workstation-two", port: 4173, status: "unreachable" })],
    });

    expect(screen.getByRole("heading", { name: "开发预览" })).toBeVisible();
    expect(screen.getByTitle(longName)).toBeVisible();
    expect(screen.getByLabelText("本机端口 5173")).toHaveTextContent("localhost:5173");
    expect(screen.getByText("可访问")).toBeVisible();
    expect(screen.queryByLabelText("本机端口 4173")).not.toBeInTheDocument();
  });

  it("shows the local-only command in an empty state and distinguishes disabled configuration", () => {
    const view = renderSection({ previews: [] });
    expect(screen.getByText("此工作站暂无开发预览")).toBeVisible();
    expect(screen.getByText("yurupager preview 5173")).toBeVisible();

    view.rerender(section({ previews: [], capability: { ...capability, enabled: false, gatewayOrigin: null } }));
    expect(screen.getByText("此服务器未启用开发预览")).toBeVisible();
    expect(screen.queryByText("yurupager preview 5173")).not.toBeInTheDocument();
  });

  it("opens one synchronous tab and posts the one-time ticket into it", async () => {
    const active = makePreview();
    const result: PreviewLaunchResult = {
      preview: active,
      ticket: "one-time-ticket",
      gatewayOrigin: "https://preview.example.test",
      expiresAt: "2026-08-11T01:02:00.000Z",
    };
    previewApi.launchPreview.mockResolvedValue(result);
    const popupDocument = document.implementation.createHTMLDocument();
    const popup = { document: popupDocument, opener: window } as unknown as Window;
    const open = vi.spyOn(window, "open").mockReturnValue(popup);
    let submitted: HTMLFormElement | null = null;
    vi.spyOn(HTMLFormElement.prototype, "submit").mockImplementation(function (this: HTMLFormElement) {
      submitted = this.cloneNode(true) as HTMLFormElement;
    });
    const onToast = vi.fn();
    renderSection({ previews: [active], onToast });

    fireEvent.click(screen.getByRole("button", { name: "打开" }));

    await waitFor(() => expect(previewApi.launchPreview).toHaveBeenCalledWith(active.id));
    await waitFor(() => expect(submitted).not.toBeNull());
    expect(open).toHaveBeenCalledTimes(1);
    expect(popup.opener).toBeNull();
    expect(submitted!.target).toMatch(/^yurupager-preview-/);
    expect(submitted!.action).toBe("https://preview.example.test/__yurupager/open");
    expect(submitted!.querySelector<HTMLInputElement>('input[name="ticket"]')?.value).toBe("one-time-ticket");
    expect(onToast).toHaveBeenCalledWith("已在新标签页打开开发预览", "success");
  });

  it("submits stop once, keeps the row, and waits for confirmation before changing status", async () => {
    const active = makePreview();
    let resolveStop!: (value: WorkstationPreviewSummary) => void;
    previewApi.stopPreview.mockReturnValue(new Promise<WorkstationPreviewSummary>((resolve) => { resolveStop = resolve; }));
    const onChanged = vi.fn();
    renderSection({ previews: [active], onChanged });

    const stop = screen.getByRole("button", { name: "停止" });
    fireEvent.click(stop);
    fireEvent.click(stop);

    expect(previewApi.stopPreview).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "正在停止" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("正在停止");
    resolveStop({ ...active, status: "stopped", stoppedAt: "2026-08-11T01:10:00.000Z", updatedAt: "2026-08-11T01:10:00.000Z" });

    await waitFor(() => expect(screen.getByText("已停止")).toBeVisible());
    expect(screen.getByTitle(active.name)).toBeVisible();
    expect(screen.getByRole("button", { name: "停止" })).toBeDisabled();
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("keeps the route and reports permission loss without submitting a form", async () => {
    const active = makePreview();
    previewApi.launchPreview.mockRejectedValue({ code: "permission_denied" });
    const popupDocument = document.implementation.createHTMLDocument();
    vi.spyOn(window, "open").mockReturnValue({ document: popupDocument, opener: window } as unknown as Window);
    const submit = vi.spyOn(HTMLFormElement.prototype, "submit").mockImplementation(() => undefined);
    renderSection({ previews: [active] });

    fireEvent.click(screen.getByRole("button", { name: "打开" }));

    await waitFor(() => expect(screen.getByText("你没有此工作站的开发预览权限")).toBeVisible());
    expect(screen.getByTitle(active.name)).toBeVisible();
    expect(submit).not.toHaveBeenCalled();
  });
});

function renderSection(overrides: Partial<Parameters<typeof section>[0]> = {}) {
  return render(section(overrides));
}

function section({
  workstationId = "workstation-one",
  previews = [makePreview()],
  capability: nextCapability = capability,
  onChanged = vi.fn(),
  onToast = vi.fn(),
}: {
  workstationId?: string;
  previews?: WorkstationPreviewSummary[];
  capability?: PreviewCapability;
  onChanged?: () => void;
  onToast?: (message: string, tone?: "success" | "error") => void;
} = {}) {
  return <WorkstationPreviewSection workstationId={workstationId} previews={previews} capability={nextCapability} onChanged={onChanged} onToast={onToast} />;
}

function makePreview(overrides: Partial<WorkstationPreviewSummary> = {}): WorkstationPreviewSummary {
  return {
    id: "preview-one",
    workspaceId: "workspace-one",
    workstationId: "workstation-one",
    workstationName: "Development Mac",
    routeId: "route-one",
    name: "Vite application",
    port: 5173,
    status: "active",
    startedAt: "2026-08-11T01:00:00.000Z",
    lastSeenAt: "2026-08-11T01:01:00.000Z",
    stoppedAt: null,
    expiresAt: "2026-08-11T03:00:00.000Z",
    updatedAt: "2026-08-11T01:01:00.000Z",
    ...overrides,
  };
}
