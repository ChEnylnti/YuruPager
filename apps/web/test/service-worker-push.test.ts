import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";

import { describe, expect, it, vi } from "vitest";

describe("Service Worker push privacy", () => {
  it("ignores supplied notification copy and navigates only with the opaque request id", async () => {
    const listeners = new Map<string, (event: any) => void>();
    const showNotification = vi.fn(async () => undefined);
    const self = {
      registration: { scope: "https://example.test/yurupager/", showNotification },
      clients: { claim: vi.fn(), matchAll: vi.fn(async () => []), openWindow: vi.fn() },
      addEventListener: (type: string, listener: (event: any) => void) => listeners.set(type, listener),
      skipWaiting: vi.fn(),
      location: { origin: "https://example.test" },
    };
    const source = readFileSync(resolve(process.cwd(), "public/sw.js"), "utf8");
    vm.runInNewContext(source, {
      self,
      URL,
      caches: { open: vi.fn(), keys: vi.fn() },
      fetch: vi.fn(),
      Promise,
    });
    let completion: Promise<unknown> = Promise.resolve();
    listeners.get("push")?.({
      data: { json: () => ({ title: "SECRET PROJECT", body: "git push --force", requestId: "opaque-request-1" }) },
      waitUntil: (promise: Promise<unknown>) => { completion = promise; },
    });
    await completion;

    expect(showNotification).toHaveBeenCalledWith("YuruPager 有新的待办", expect.objectContaining({
      body: "打开应用查看当前状态。",
      tag: "opaque-request-1",
      data: { url: "/yurupager/?view=inbox&request=opaque-request-1" },
    }));
    expect(JSON.stringify(showNotification.mock.calls)).not.toContain("SECRET PROJECT");
    expect(JSON.stringify(showNotification.mock.calls)).not.toContain("git push --force");
  });
});
