import { afterEach, describe, expect, it, vi } from "vitest";

import type { PreviewLaunchResult, WorkstationPreviewSummary } from "@yurupager/shared";

import { previewLaunchAction, submitPreviewLaunch } from "../src/preview-launch.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("preview launch form", () => {
  it("posts the ticket to the gateway root without exposing it in the URL", () => {
    let submitted: HTMLFormElement | null = null;
    vi.spyOn(HTMLFormElement.prototype, "submit").mockImplementation(function (this: HTMLFormElement) {
      submitted = this.cloneNode(true) as HTMLFormElement;
    });

    submitPreviewLaunch(launchResult(), "preview-target");

    expect(submitted).not.toBeNull();
    expect(submitted!.method).toBe("post");
    expect(submitted!.action).toBe("https://preview.example.test/__yurupager/open");
    expect(submitted!.target).toBe("preview-target");
    expect(submitted!.action).not.toContain("one-time-ticket");
    expect(submitted!.querySelector<HTMLInputElement>('input[name="ticket"]')?.value).toBe("one-time-ticket");
    expect(document.querySelector('form[action="https://preview.example.test/__yurupager/open"]')).not.toBeInTheDocument();
  });

  it("uses only the declared origin and rejects non-HTTP gateways", () => {
    expect(previewLaunchAction("https://preview.example.test/configured/path?ignored=yes")).toBe("https://preview.example.test/__yurupager/open");
    expect(() => previewLaunchAction("javascript:alert(1)")).toThrow("Invalid preview gateway origin");
    expect(() => previewLaunchAction("https://user:secret@preview.example.test")).toThrow("Invalid preview gateway origin");
  });
});

function launchResult(): PreviewLaunchResult {
  return {
    preview: preview(),
    ticket: "one-time-ticket",
    gatewayOrigin: "https://preview.example.test/configured/path",
    expiresAt: "2026-08-11T01:02:00.000Z",
  };
}

function preview(): WorkstationPreviewSummary {
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
  };
}
