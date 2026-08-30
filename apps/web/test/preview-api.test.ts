import { afterEach, describe, expect, it, vi } from "vitest";

import type { PreviewLaunchResult, WorkstationPreviewSummary } from "@yurupager/shared";

import { launchPreview, stopPreview } from "../src/api.js";

const preview: WorkstationPreviewSummary = {
  id: "preview/one",
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("preview API", () => {
  it("requests a one-time launch ticket without putting it in the URL", async () => {
    const result: PreviewLaunchResult = {
      preview,
      ticket: "one-time-ticket",
      gatewayOrigin: "https://preview.example.test",
      expiresAt: "2026-08-11T01:02:00.000Z",
    };
    const fetch = vi.fn().mockResolvedValue(okResponse(result));
    vi.stubGlobal("fetch", fetch);

    await expect(launchPreview(preview.id)).resolves.toEqual(result);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("/api/previews/preview%2Fone/launch", expect.objectContaining({
      method: "POST",
      credentials: "include",
      body: "{}",
    }));
    expect(String(fetch.mock.calls[0]?.[0])).not.toContain(result.ticket);
  });

  it("returns the confirmed stopped preview", async () => {
    const stopped = { ...preview, status: "stopped" as const, stoppedAt: "2026-08-11T01:10:00.000Z" };
    const fetch = vi.fn().mockResolvedValue(okResponse({ preview: stopped }));
    vi.stubGlobal("fetch", fetch);

    await expect(stopPreview(preview.id)).resolves.toEqual(stopped);
    expect(fetch).toHaveBeenCalledWith("/api/previews/preview%2Fone/stop", expect.objectContaining({ method: "POST", body: "{}" }));
  });
});

function okResponse(value: unknown): Pick<Response, "ok" | "status" | "json"> {
  return { ok: true, status: 200, json: async () => value };
}
