import { resolve } from "node:path";

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import type { Snapshot, WorkstationPreviewSummary } from "@yurupager/shared";

const screenshots = resolve(process.cwd(), "../../artifacts/screenshots");
const companyWorkspace = "Yuru Systems Product Engineering";
const workspaceId = "20000000-0000-4000-8000-000000000002";
const workstationId = "30000000-0000-4000-8000-000000000001";
const workstationName = "Levinthal MacBook Pro";
const longPreviewName = "YuruPager Vite application with a deliberately long development preview route label";
const activePreviewId = "70000000-0000-4000-8000-000000000001";
const deniedPreviewId = "70000000-0000-4000-8000-000000000002";

interface PreviewSnapshotState {
  mode: "empty" | "available";
}

interface CapturedPreviewSubmission {
  action: string;
  method: string;
  target: string;
  ticket: string | null;
}

test("desktop workstation previews preserve explicit launch and stop boundaries", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const state: PreviewSnapshotState = { mode: "empty" };
  await installPreviewFormCapture(page);
  await installPreviewSnapshot(page, state);

  let launchRequests = 0;
  await page.route("**/api/previews/*/launch", async (route) => {
    launchRequests += 1;
    const previewId = decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-2) ?? "");
    if (previewId === deniedPreviewId) {
      await route.fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "permission_denied", message: "Preview permission was revoked" } }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        preview: previewFixture(activePreviewId, longPreviewName, 51_735),
        ticket: "e2e-one-time-preview-ticket",
        gatewayOrigin: "https://preview.e2e.invalid/configured/path",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    });
  });

  let stopRequests = 0;
  let releaseStop = () => undefined;
  const stopGate = new Promise<void>((resolveGate) => { releaseStop = resolveGate; });
  await page.route(`**/api/previews/${activePreviewId}/stop`, async (route) => {
    stopRequests += 1;
    await stopGate;
    const stoppedAt = new Date(Date.now() + 5_000).toISOString();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        preview: {
          ...previewFixture(activePreviewId, longPreviewName, 51_735),
          status: "stopped",
          stoppedAt,
          updatedAt: stoppedAt,
        },
      }),
    });
  });

  await login(page);
  await selectCompanyWorkspace(page);
  await page.getByRole("button", { name: "工作站", exact: true }).click();
  await expectStableLayer(page, ".snapshot-shell > .t-skel-content");
  await expect(page.getByRole("heading", { name: "开发预览" })).toBeVisible();
  await expect(page.getByText("此工作站暂无开发预览")).toBeVisible();
  await expect(page.getByText("yurupager preview 5173")).toBeVisible();
  await expectNoPageOverflow(page);
  await page.screenshot({ path: resolve(screenshots, "desktop-alpha-preview-empty.png"), fullPage: true });

  state.mode = "available";
  await page.getByRole("button", { name: "刷新快照" }).click();
  const activeRow = page.locator(".preview-row").filter({ has: page.getByLabel("本机端口 51735") });
  await expect(activeRow).toBeVisible();
  await expect(activeRow.getByTitle(longPreviewName)).toBeVisible();
  await expect(activeRow.getByText("可访问")).toBeVisible();
  await expect(activeRow.getByRole("button", { name: "打开" })).toBeEnabled();
  await expectNoPageOverflow(page);
  await expectPreviewTextContained(activeRow);
  await page.getByRole("heading", { name: "开发预览" }).hover();
  await activeRow.getByRole("button", { name: "打开" }).focus();
  await expect(page.getByRole("tooltip", { name: "刷新快照" })).toHaveCSS("opacity", "0");
  await page.screenshot({ path: resolve(screenshots, "desktop-alpha-preview-active.png"), fullPage: true });

  const popupPromise = page.waitForEvent("popup");
  await activeRow.getByRole("button", { name: "打开" }).click();
  const popup = await popupPromise;
  await expect.poll(() => capturedSubmissions(page)).toHaveLength(1);
  const submission = (await capturedSubmissions(page))[0];
  expect(submission).toEqual(expect.objectContaining({
    action: "https://preview.e2e.invalid/__yurupager/open",
    method: "post",
    ticket: "e2e-one-time-preview-ticket",
  }));
  expect(submission?.target).toMatch(/^yurupager-preview-/);
  expect(submission?.action).not.toContain("e2e-one-time-preview-ticket");
  expect(launchRequests).toBe(1);
  await popup.close();

  const deniedRow = page.locator(".preview-row").filter({ has: page.getByLabel("本机端口 4173") });
  const deniedPopupPromise = page.waitForEvent("popup");
  await deniedRow.getByRole("button", { name: "打开" }).click();
  const deniedPopup = await deniedPopupPromise;
  await expect(page.locator(".preview-feedback")).toHaveText("你没有此工作站的开发预览权限");
  await expect(page.getByRole("alert")).toHaveCount(1);
  await expect(deniedRow).toBeVisible();
  await expect.poll(() => capturedSubmissions(page)).toHaveLength(1);
  await page.bringToFront();
  await page.screenshot({ path: resolve(screenshots, "desktop-alpha-preview-permission.png"), fullPage: true });
  await deniedPopup.close();
  await dismissToast(page);

  await page.emulateMedia({ reducedMotion: "reduce" });
  const stopButton = activeRow.getByRole("button", { name: "停止" });
  await stopButton.evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
  await expect.poll(() => stopRequests).toBe(1);
  await expect(activeRow.getByRole("button", { name: "正在停止" })).toBeDisabled();
  await expect(activeRow.getByRole("status")).toContainText("正在停止");
  await expect(activeRow.getByRole("button", { name: "正在停止" }).locator(".spinner")).toHaveCSS("animation-name", "none");
  await expect(activeRow.locator(".preview-status")).toHaveCSS("transition-duration", "0s");
  await page.screenshot({ path: resolve(screenshots, "desktop-alpha-preview-stopping-reduced-motion.png"), fullPage: true });
  releaseStop();

  await expect(activeRow.getByText("已停止")).toBeVisible();
  await expect(activeRow.getByRole("button", { name: "停止" })).toBeDisabled();
  await dismissToast(page);
  await expectNoPageOverflow(page);
  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
});

test("mobile workstation previews keep long routes and actions operable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state: PreviewSnapshotState = { mode: "empty" };
  await installPreviewFormCapture(page);
  await installPreviewSnapshot(page, state);
  await page.route(`**/api/previews/${activePreviewId}/launch`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        preview: previewFixture(activePreviewId, longPreviewName, 51_735),
        ticket: "e2e-mobile-preview-ticket",
        gatewayOrigin: "https://preview.e2e.invalid",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    });
  });

  await login(page);
  await selectCompanyWorkspace(page);
  await page.getByRole("button", { name: "工作站", exact: true }).click();
  await expectStableLayer(page, ".snapshot-shell > .t-skel-content");
  await expect(page.getByText("此工作站暂无开发预览")).toBeVisible();
  await expect(page.getByText("yurupager preview 5173")).toBeVisible();
  await expectNoPageOverflow(page);
  await page.screenshot({ path: resolve(screenshots, "mobile-alpha-preview-empty.png"), fullPage: true });

  state.mode = "available";
  await page.getByRole("button", { name: "刷新快照" }).click();
  const row = page.locator(".preview-row").filter({ has: page.getByLabel("本机端口 51735") });
  await expect(row).toBeVisible();
  await row.scrollIntoViewIfNeeded();
  await expect(row.getByTitle(longPreviewName)).toBeVisible();
  await expect(row.getByText("可访问")).toBeVisible();
  await expectPreviewTextContained(row);
  for (const action of ["打开", "停止"]) {
    const box = await row.getByRole("button", { name: action }).boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  }
  await expect(page.locator("iframe")).toHaveCount(0);
  await expectNoPageOverflow(page);
  await page.getByRole("heading", { name: "开发预览" }).hover();
  await row.getByRole("button", { name: "打开" }).focus();
  await expect(page.getByRole("tooltip", { name: "刷新快照" })).toHaveCSS("opacity", "0");
  await page.screenshot({ path: resolve(screenshots, "mobile-alpha-preview-active.png"), fullPage: true });

  const popupPromise = page.waitForEvent("popup");
  await row.getByRole("button", { name: "打开" }).click();
  const popup = await popupPromise;
  await expect.poll(() => capturedSubmissions(page)).toHaveLength(1);
  expect((await capturedSubmissions(page))[0]).toEqual(expect.objectContaining({
    action: "https://preview.e2e.invalid/__yurupager/open",
    method: "post",
    ticket: "e2e-mobile-preview-ticket",
  }));
  await popup.close();
  await dismissToast(page);

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
});

async function installPreviewSnapshot(page: Page, state: PreviewSnapshotState): Promise<void> {
  await page.route("**/api/snapshot*", async (route) => {
    const response = await route.fetch();
    const snapshot = await response.json() as Snapshot;
    await route.fulfill({
      response,
      json: {
        ...snapshot,
        previews: state.mode === "available"
          ? [
              previewFixture(activePreviewId, longPreviewName, 51_735),
              previewFixture(deniedPreviewId, "Team dashboard permission verification", 4_173),
            ]
          : [],
        previewCapability: {
          enabled: true,
          gatewayOrigin: "https://preview.e2e.invalid",
          command: "yurupager preview <port>",
        },
      },
    });
  });
}

async function installPreviewFormCapture(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const browserWindow = window as Window & { __yurupagerPreviewSubmissions?: CapturedPreviewSubmission[] };
    browserWindow.__yurupagerPreviewSubmissions = [];
    HTMLFormElement.prototype.submit = function submit(): void {
      browserWindow.__yurupagerPreviewSubmissions?.push({
        action: this.action,
        method: this.method,
        target: this.target,
        ticket: new FormData(this).get("ticket")?.toString() ?? null,
      });
    };
  });
}

async function capturedSubmissions(page: Page): Promise<CapturedPreviewSubmission[]> {
  return page.evaluate(() => {
    const browserWindow = window as Window & { __yurupagerPreviewSubmissions?: CapturedPreviewSubmission[] };
    return browserWindow.__yurupagerPreviewSubmissions ?? [];
  });
}

function previewFixture(id: string, name: string, port: number): WorkstationPreviewSummary {
  const now = new Date().toISOString();
  return {
    id,
    workspaceId,
    workstationId,
    workstationName,
    routeId: id.replace(/^70000000/, "71000000"),
    name,
    port,
    status: "active",
    startedAt: now,
    lastSeenAt: now,
    stoppedAt: null,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    updatedAt: now,
  };
}

async function login(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByLabel("邮箱").fill("alice@yurupager.local");
  await page.getByLabel("密码").fill("alpha-demo");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByRole("heading", { name: "请求", exact: true })).toBeVisible();
}

async function selectCompanyWorkspace(page: Page): Promise<void> {
  const workspace = page.getByLabel("工作区", { exact: true });
  await workspace.selectOption({ label: companyWorkspace });
  await expect(workspace).toHaveValue(workspaceId);
}

async function expectPreviewTextContained(row: ReturnType<Page["locator"]>): Promise<void> {
  const containment = await row.evaluate((element) => {
    const name = element.querySelector<HTMLElement>(".preview-identity strong");
    const buttons = [...element.querySelectorAll<HTMLElement>("button")];
    return {
      nameOverflow: name === null ? "missing" : getComputedStyle(name).overflow,
      nameWrap: name === null ? "missing" : getComputedStyle(name).whiteSpace,
      buttonsFit: buttons.every((button) => button.scrollWidth <= button.clientWidth),
    };
  });
  expect(containment).toEqual({ nameOverflow: "hidden", nameWrap: "nowrap", buttonsFit: true });
}

async function expectNoPageOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    main: document.querySelector("main") === null ? 0 : document.querySelector("main")!.scrollWidth - document.querySelector("main")!.clientWidth,
  }));
  expect(overflow.document).toBeLessThanOrEqual(0);
  expect(overflow.main).toBeLessThanOrEqual(0);
}

async function expectStableLayer(page: Page, selector: string): Promise<void> {
  const layer = page.locator(selector);
  await expect(layer).toHaveCSS("opacity", "1");
  await expect(layer).toHaveCSS("filter", "blur(0px)");
}

async function dismissToast(page: Page): Promise<void> {
  const close = page.getByRole("button", { name: "关闭通知" });
  await expect(close).toBeVisible();
  await close.click();
  await expect(close).toHaveCount(0);
}
