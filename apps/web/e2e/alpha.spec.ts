import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import type { RequestSummary, Snapshot, WorkstationPairingSummary } from "@yurupager/shared";

const screenshots = resolve(process.cwd(), "../../artifacts/screenshots");
const companyWorkspace = "Yuru Systems Product Engineering";
const imageFixtureBytes = readFileSync(resolve(process.cwd(), "public/icons/icon-192.png"));
const imageFixture = {
  base64: imageFixtureBytes.toString("base64"),
  byteLength: imageFixtureBytes.byteLength,
  sha256: createHash("sha256").update(imageFixtureBytes).digest("hex"),
};

test("desktop console supports scanning, navigation, focus return, and reduced motion", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, "alice@yurupager.local");
  await expectStableLayer(page, ".snapshot-shell > .t-skel-content");
  await selectWorkspace(page, companyWorkspace);

  await expect(page.getByRole("heading", { name: "请求", exact: true })).toBeVisible();
  await expect(page.locator(".identity-strip").getByText(companyWorkspace)).toBeVisible();
  await expectStableLayer(page, ".snapshot-shell > .t-skel-content");
  await expectNoPageOverflow(page);
  await page.screenshot({ path: resolve(screenshots, "desktop-alpha-inbox.png"), fullPage: true });

  const refresh = page.getByRole("button", { name: "刷新快照" });
  const notifications = page.locator(".notification-trigger");
  await page.getByLabel("工作区", { exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(notifications).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(refresh).toBeFocused();
  await expect(page.getByRole("tooltip", { name: "刷新快照" })).toHaveCSS("opacity", "1");

  const highRiskRow = page.locator(".request-row").filter({ hasText: "force-with-lease" });
  await highRiskRow.click();
  const approve = page.getByRole("button", { name: "批准" });
  await approve.click();
  const dialog = page.getByRole("dialog", { name: "确认高风险批准" });
  await expect(dialog).toHaveClass(/is-open/);
  await expect(dialog).toHaveCSS("opacity", "1");
  await page.screenshot({ path: resolve(screenshots, "desktop-alpha-high-risk.png"), fullPage: true });
  await page.getByRole("button", { name: "取消" }).click();
  await expect(dialog).toBeHidden();
  await expect(approve).toBeFocused();

  await page.emulateMedia({ reducedMotion: "reduce" });
  await approve.click();
  await expect(page.getByRole("dialog")).toHaveCSS("transition-duration", "0s");
  await page.getByRole("button", { name: "取消" }).click();
  await expect(dialog).toBeHidden();

  for (const view of ["工作站", "会话", "用量", "成员", "审计"]) {
    await page.getByRole("button", { name: view, exact: true }).click();
    await expect(page.getByRole("heading", { name: view === "用量" ? "Token 用量" : view === "成员" ? "成员与授权" : view === "审计" ? "审计历史" : view, exact: true })).toBeVisible();
  }

  await page.getByRole("button", { name: "工作站", exact: true }).click();
  await page.getByLabel("工作区", { exact: true }).selectOption({ label: "Alice Personal" });
  await expect(page.getByRole("heading", { name: "Home Mac mini with a deliberately long workstation label for overflow verification", exact: true })).toBeVisible();
  await expectNoPageOverflow(page);
  await page.screenshot({ path: resolve(screenshots, "desktop-alpha-long-text.png"), fullPage: true });

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
});

test("notification settings preserve focus, motion boundaries, and narrow mobile layout", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, "alice@yurupager.local");
  await expectStableLayer(page, ".snapshot-shell > .t-skel-content");

  const trigger = page.locator(".notification-trigger");
  await trigger.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "待办通知" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveClass(/is-open/);
  await expect(dialog).toHaveCSS("opacity", "1");
  await expect(dialog).toHaveCSS("transition-duration", /^0\.25s(?:, 0\.25s)?$/);
  await expect(page.getByRole("button", { name: "关闭通知设置" })).toBeFocused();
  await expectNoPageOverflow(page);
  await page.screenshot({ path: resolve(screenshots, "desktop-alpha-notification-settings.png"), fullPage: true });

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();

  await page.setViewportSize({ width: 390, height: 844 });
  await trigger.click();
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveCSS("opacity", "1");
  await expectElementInsideViewport(page, ".notification-menu");
  await expectNoPageOverflow(page);
  await page.screenshot({ path: resolve(screenshots, "mobile-alpha-notification-settings.png"), fullPage: true });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  await page.setViewportSize({ width: 320, height: 720 });
  await expect(trigger).toBeVisible();
  const touchTarget = await trigger.boundingBox();
  expect(touchTarget?.width ?? 0).toBeGreaterThanOrEqual(44);
  expect(touchTarget?.height ?? 0).toBeGreaterThanOrEqual(44);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await trigger.click();
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveCSS("transition-duration", /^0s(?:, 0s)?$/);
  await expectElementInsideViewport(page, ".notification-menu");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
});

test("workspace management remains reachable on narrow screens and exposes explicit member controls", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await login(page, "alice@yurupager.local");
  await selectWorkspace(page, companyWorkspace);

  const workspaceAction = page.getByRole("button", { name: "工作区操作" });
  await expect(workspaceAction).toBeVisible();
  const actionBox = await workspaceAction.boundingBox();
  expect(actionBox?.width ?? 0).toBeGreaterThanOrEqual(44);
  expect(actionBox?.height ?? 0).toBeGreaterThanOrEqual(44);
  await workspaceAction.click();
  await expect(page.getByRole("dialog", { name: "工作区操作" })).toBeVisible();
  await expectNoPageOverflow(page);
  await page.screenshot({ path: resolve(screenshots, "mobile-alpha-workspace-menu.png"), fullPage: true });
  await page.keyboard.press("Escape");

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "成员", exact: true }).click();
  await expect(page.getByRole("heading", { name: "成员与授权", exact: true })).toBeVisible();
  await expectStableLayer(page, ".snapshot-shell > .t-skel-content");
  await expect(page.getByRole("combobox", { name: "成员角色：Bob Lin" })).toBeVisible();
  await page.screenshot({ path: resolve(screenshots, "desktop-alpha-members-management.png"), fullPage: true });
  await expectNoPageOverflow(page);
  await page.waitForTimeout(500);
  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
});

test("slow duplicate confirmation submits once and does not optimistically finalize", async ({ page }) => {
  await login(page, "alice@yurupager.local");
  await selectWorkspace(page, companyWorkspace);
  const snapshot = await snapshotFromPage(page);
  const request = requireRequest(snapshot, (item) => item.risk === "high" && item.status === "pending");
  let submissions = 0;
  let releaseResponse = () => {};
  const responseGate = new Promise<void>((resolveGate) => { releaseResponse = resolveGate; });
  await page.route(`**/api/requests/${request.id}/decision`, async (route) => {
    submissions += 1;
    await responseGate;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        replayed: false,
        request: {
          ...request,
          status: "approved",
          deliveryStatus: "queued",
          decidedByName: "Alice Chen",
          decidedAt: new Date().toISOString(),
        },
      }),
    });
  });

  await page.goto(`/?view=inbox&request=${request.id}`);
  await page.getByRole("button", { name: "批准" }).click();
  const confirm = page.getByRole("button", { name: "确认批准" });
  await confirm.evaluate((element: HTMLButtonElement) => { element.click(); element.click(); });
  await expect.poll(() => submissions).toBe(1);
  await expect(page.locator(".request-detail .status-badge")).toHaveText("待处理");
  await expect(page.getByRole("button", { name: "提交中" })).toBeDisabled();
  releaseResponse();
  await expect(page.getByText("批准已记录")).toBeVisible();
  expect(submissions).toBe(1);
});

test("a collaborator without high-risk permission sees a fail-closed error", async ({ page }) => {
  await login(page, "bob@yurupager.local");
  const highRiskRow = page.locator(".request-row").filter({ hasText: "force-with-lease" });
  await highRiskRow.click();
  await page.getByRole("button", { name: "批准" }).click();
  await page.getByRole("button", { name: "确认批准" }).click();
  await expect(page.getByText("你无权处理此请求")).toBeVisible();
  await expect(page.locator(".request-detail .status-badge")).toHaveText("待处理");
});

test("questions and denials require complete explicit submissions", async ({ page }) => {
  await login(page, "alice@yurupager.local");
  await selectWorkspace(page, companyWorkspace);
  const snapshot = await snapshotFromPage(page);
  const question = requireRequest(snapshot, (item) => item.kind === "question" && item.status === "pending");
  const approval = requireRequest(snapshot, (item) => item.kind === "approval" && item.risk === "medium" && item.status === "pending");
  const submissions: Array<Record<string, unknown>> = [];

  for (const request of [question, approval]) {
    await page.route(`**/api/requests/${request.id}/decision`, async (route) => {
      const input = route.request().postDataJSON() as Record<string, unknown>;
      submissions.push(input);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          replayed: false,
          request: {
            ...request,
            status: input.decision === "deny" ? "denied" : "approved",
            deliveryStatus: "queued",
            decidedByName: "Alice Chen",
            decisionReason: typeof input.reason === "string" ? input.reason : null,
            decidedAt: new Date().toISOString(),
          },
        }),
      });
    });
  }

  await page.goto(`/?view=inbox&request=${question.id}`);
  const submitAnswer = page.getByRole("button", { name: "提交回答" });
  await expect(submitAnswer).toBeDisabled();
  await page.getByLabel("Staging").check();
  await expect(submitAnswer).toBeEnabled();
  await submitAnswer.click();
  await expect(page.getByText("回答已发送")).toBeVisible();

  await page.goto(`/?view=inbox&request=${approval.id}`);
  await page.getByRole("button", { name: "拒绝" }).click();
  const submitDenial = page.getByRole("button", { name: "提交拒绝" });
  await expect(submitDenial).toBeDisabled();
  await page.getByLabel("原因").fill("The requested command needs a narrower scope.");
  await expect(submitDenial).toBeEnabled();
  await submitDenial.click();
  await expect(page.getByText("请求已拒绝")).toBeVisible();

  expect(submissions).toEqual([
    { decision: "answer", answers: { environment: ["Staging"] } },
    { decision: "deny", reason: "The requested command needs a narrower scope." },
  ]);
});

test("a collaborator win replaces local actions with the actual operator", async ({ page }) => {
  await login(page, "alice@yurupager.local");
  await selectWorkspace(page, companyWorkspace);
  const snapshot = await snapshotFromPage(page);
  const request = requireRequest(snapshot, (item) => item.kind === "approval" && item.risk === "medium" && item.status === "pending");
  const handled = {
    ...request,
    status: "denied" as const,
    deliveryStatus: "queued" as const,
    decidedByName: "Bob Lin",
    decisionReason: "Handled from another device",
    decidedAt: new Date().toISOString(),
  };
  await page.route(`**/api/requests/${request.id}/decision`, async (route) => {
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "decision_conflict", message: "Another collaborator handled this request", details: { request: handled } } }),
    });
  });

  await page.goto(`/?view=inbox&request=${request.id}`);
  await page.getByRole("button", { name: "批准" }).click();
  await page.getByRole("button", { name: "确认批准" }).click();
  await expect(page.getByText("另一位协作者已处理此请求")).toBeVisible();
  await expect(page.getByText("已拒绝，操作人：Bob Lin")).toBeVisible();
  await expect(page.getByRole("button", { name: "批准" })).toHaveCount(0);
});

test("temporary Codex conversation rebuilds on desktop and remains usable on mobile", async ({ page }) => {
  await installConversationWebSocket(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, "alice@yurupager.local");
  await selectWorkspace(page, companyWorkspace);
  await page.getByRole("button", { name: "会话", exact: true }).click();
  const snapshot = await snapshotFromPage(page);
  const session = snapshot.sessions.find((item) => item.projectName === "YuruPager");
  if (session === undefined) throw new Error("YuruPager session is missing");
  await expect(page.locator(`[data-session-id="${session.id}"]`)).toContainText("创建私人仓库并提交项目");
  await page.locator(`[data-session-id="${session.id}"]`).click();

  await expect(page.getByRole("log", { name: "Codex 会话消息" })).toContainText("已完成端到端验证");
  await expect(page.getByRole("log", { name: "Codex 会话消息" })).toContainText("已读取 main.mjs");
  await expect(page.locator('[data-activity-id="browser-command"]')).toHaveCount(1);
  const returnedImage = page.getByRole("button", { name: "查看Codex的图片" });
  await expect(returnedImage).toBeAttached();
  await expect(page.locator(".stream-status .t-text-swap")).toHaveText("实时");
  await expect(page.locator(".timeline-user .message-plain")).toHaveCSS("white-space", "pre-wrap");
  await expect(page.getByRole("heading", { name: "每日中文重点简报 | 2026年8月14日" })).toBeVisible();
  await expect(page.getByText("DeepSeek 正式发布 V4 Pro。")).toBeVisible();
  await expect(page.getByRole("link", { name: "Reuters" })).toHaveAttribute("href", "https://www.reuters.com/world/china/deepseek-releases-official-v4-pro-model-it-steps-up-expansion-2026-08-13/");
  await expectNoPageOverflow(page);
  await page.screenshot({ path: resolve(screenshots, "desktop-alpha-conversation.png"), fullPage: true });
  await returnedImage.click();
  const imageViewer = page.getByRole("dialog", { name: "查看 Codex 返回的图片" });
  await expect(imageViewer).toBeVisible();
  await expect(page.getByRole("button", { name: "关闭图片" })).toBeFocused();
  await page.screenshot({ path: resolve(screenshots, "desktop-alpha-image-viewer.png"), fullPage: true });
  await page.keyboard.press("Escape");
  await expect(returnedImage).toBeFocused();

  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator(".stream-status .t-text-swap")).toHaveCSS("transition-duration", "0s");

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("log", { name: "Codex 会话消息" })).toBeVisible();
  await expect(page.getByLabel("发送给 Codex")).toBeVisible();
  await expectNoPageOverflow(page);
  await page.screenshot({ path: resolve(screenshots, "mobile-alpha-conversation.png"), fullPage: true });
  await returnedImage.click();
  await expect(imageViewer).toBeVisible();
  await page.screenshot({ path: resolve(screenshots, "mobile-alpha-image-viewer.png"), fullPage: true });
  await page.keyboard.press("Escape");

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
});

test("Codex returned images remain inspectable across desktop, mobile, focus, and reduced motion", async ({ page }) => {
  await installConversationWebSocket(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, "alice@yurupager.local");
  await selectWorkspace(page, companyWorkspace);
  await page.getByRole("button", { name: "会话", exact: true }).click();
  const snapshot = await snapshotFromPage(page);
  const session = snapshot.sessions.find((item) => item.projectName === "YuruPager");
  if (session === undefined) throw new Error("YuruPager session is missing");
  await page.locator(`[data-session-id="${session.id}"]`).click();

  const returnedImage = page.getByRole("button", { name: "查看Codex的图片" });
  await expect(returnedImage).toBeVisible();
  await expect(returnedImage.locator("img")).toHaveJSProperty("complete", true);
  await expect.poll(() => returnedImage.locator("img").evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  await returnedImage.evaluate((element) => element.scrollIntoView({ block: "center" }));
  await expectNoPageOverflow(page);
  await page.screenshot({ path: resolve(screenshots, "desktop-alpha-session-images.png"), fullPage: true });

  await returnedImage.click();
  const viewer = page.getByRole("dialog", { name: "查看 Codex 返回的图片" });
  const close = page.getByRole("button", { name: "关闭图片" });
  await expect(viewer).toBeVisible();
  await expect(viewer).toHaveCSS("opacity", "1");
  await expect(close).toBeFocused();
  await expect.poll(() => viewer.locator("img").evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  const desktopViewerBox = await page.locator(".image-viewer").boundingBox();
  expect(desktopViewerBox?.x ?? 1).toBeLessThanOrEqual(0);
  expect(desktopViewerBox?.y ?? 1).toBeLessThanOrEqual(0);
  expect(desktopViewerBox?.width ?? 0).toBeGreaterThanOrEqual(1440);
  expect(desktopViewerBox?.height ?? 0).toBeGreaterThanOrEqual(900);
  await page.screenshot({ path: resolve(screenshots, "desktop-alpha-image-viewer.png"), fullPage: true });
  await page.keyboard.press("Escape");
  await expect(viewer).toBeHidden();
  await expect(returnedImage).toBeFocused();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(returnedImage).toBeVisible();
  await expect(page.getByLabel("发送给 Codex")).toBeVisible();
  await expectNoPageOverflow(page);
  await page.screenshot({ path: resolve(screenshots, "mobile-alpha-session-images.png"), fullPage: true });

  await returnedImage.click();
  await expect(viewer).toBeVisible();
  await expect(viewer).toHaveCSS("opacity", "1");
  await expect(close).toBeFocused();
  const mobileViewerBox = await page.locator(".image-viewer").boundingBox();
  expect(mobileViewerBox?.x ?? 1).toBeLessThanOrEqual(0);
  expect(mobileViewerBox?.y ?? 1).toBeLessThanOrEqual(0);
  expect(mobileViewerBox?.width ?? 0).toBeGreaterThanOrEqual(390);
  expect(mobileViewerBox?.height ?? 0).toBeGreaterThanOrEqual(844);
  await page.screenshot({ path: resolve(screenshots, "mobile-alpha-image-viewer.png"), fullPage: true });
  await page.keyboard.press("Escape");
  await expect(viewer).toBeHidden();
  await expect(returnedImage).toBeFocused();

  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect.poll(() => page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
  await returnedImage.click();
  await expect(viewer).toBeVisible();
  await expect(page.locator(".image-viewer-dialog")).toHaveCSS("transition-duration", "0s");
  await page.keyboard.press("Escape");
  await expect(returnedImage).toBeFocused();

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
});

test("desktop session index groups Codex conversations by project and supports disclosure", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, "alice@yurupager.local");
  await selectWorkspace(page, companyWorkspace);
  const snapshot = await snapshotFromPage(page);
  const seed = snapshot.sessions.find((item) => item.projectName === "YuruPager");
  if (seed === undefined) throw new Error("YuruPager session is missing");
  const discovered = [
    {
      ...seed,
      id: "40000000-0000-4000-8000-000000000091",
      threadId: "thread-trace-agent-recent",
      projectKey: "project-trace-agent-canonical",
      projectName: "trace-agent",
      projectPath: "/Users/levinthal/lws/upgrade/trace",
      updatedAt: "2026-08-09T13:12:00.000Z",
    },
    {
      ...seed,
      id: "40000000-0000-4000-8000-000000000092",
      threadId: "thread-trace-agent-older",
      projectKey: "project-trace-agent-canonical",
      projectName: "trace-agent",
      projectPath: "/Users/levinthal/lws/upgrade/trace",
      updatedAt: "2026-08-09T12:12:00.000Z",
    },
  ];
  await page.route("**/api/snapshot*", async (route) => {
    const response = await route.fetch();
    const current = await response.json() as Snapshot;
    await route.fulfill({ response, json: { ...current, sessions: [...discovered, ...current.sessions] } });
  });

  await page.goto("/?view=sessions");
  await expectStableLayer(page, ".snapshot-shell > .t-skel-content");
  const project = page.getByRole("button", { name: /trace-agent/ });
  await expect(project).toBeVisible();
  await expect(project).toHaveAttribute("aria-expanded", "true");
  const group = page.getByRole("group", { name: "trace-agent 的会话" });
  await expect(group.locator(".session-row")).toHaveCount(2);
  await expect(group.locator(".session-row").first()).toContainText("thread-t");
  await expectNoPageOverflow(page);
  await page.screenshot({ path: resolve(screenshots, "desktop-alpha-project-index.png"), fullPage: true });

  await project.click();
  await expect(project).toHaveAttribute("aria-expanded", "false");
  await expect(group).toBeHidden();
  await project.click();
  await expect(project).toHaveAttribute("aria-expanded", "true");
  await expect(group).toBeVisible();
  await expect(group.locator(".t-acc-panel-inner")).toHaveCSS("opacity", "1");
  await expect(group.locator(".t-acc-panel-inner")).toHaveCSS("filter", "blur(0px)");
  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
});

test("mobile sessions use a list-to-conversation hierarchy with a keyboard-safe composer", async ({ page }) => {
  await installConversationWebSocket(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, "alice@yurupager.local");
  await selectWorkspace(page, companyWorkspace);
  await page.getByRole("button", { name: "会话", exact: true }).click();
  const snapshot = await snapshotFromPage(page);
  const session = snapshot.sessions.find((item) => item.projectName === "YuruPager");
  if (session === undefined) throw new Error("YuruPager session is missing");

  const sessionIndex = page.locator(".view-sessions .session-index");
  await expect(sessionIndex).toBeVisible();
  await expect(sessionIndex).toHaveCSS("filter", "blur(0px)");
  await expect(sessionIndex).toHaveCSS("opacity", "1");
  await expect(page.locator(".view-sessions .session-detail-pane")).toHaveAttribute("aria-hidden", "true");
  await expect(page.locator(".top-bar")).toBeVisible();
  await expect(page.locator(".bottom-nav")).toBeVisible();
  await expect(page.getByRole("log", { name: "Codex 会话消息" })).toBeHidden();
  await expectStableLayer(page, ".snapshot-shell > .t-skel-content");
  await page.screenshot({ path: resolve(screenshots, "mobile-alpha-session-list.png"), fullPage: true });

  const sessionRow = page.locator(`[data-session-id="${session.id}"]`);
  await sessionRow.click();
  await expect(page.locator(".mobile-session-header")).toBeVisible();
  await expect(page.getByRole("log", { name: "Codex 会话消息" })).toContainText("已完成端到端验证");
  await expect(page.locator(".top-bar")).toBeHidden();
  await expect(page.locator(".bottom-nav")).toBeHidden();
  await expect(page.locator(".view-sessions .session-index")).toHaveAttribute("aria-hidden", "true");
  await expect(page.locator(".view-sessions .metric-strip")).toBeHidden();
  await expect(page.locator(".view-sessions .session-records")).toBeHidden();

  const timelineBox = await page.locator(".session-timeline").boundingBox();
  const composerBox = await page.locator(".session-composer").boundingBox();
  const headerBox = await page.locator(".mobile-session-header").boundingBox();
  expect(timelineBox?.height ?? 0).toBeGreaterThanOrEqual(240);
  expect((headerBox?.y ?? 0) + (headerBox?.height ?? 0)).toBeLessThanOrEqual((timelineBox?.y ?? 0) + 1);
  expect((timelineBox?.y ?? 0) + (timelineBox?.height ?? 0)).toBeLessThanOrEqual((composerBox?.y ?? 0) + 1);
  expect((composerBox?.y ?? 0) + (composerBox?.height ?? 0)).toBeLessThanOrEqual(845);

  for (const viewport of [{ width: 320, height: 568 }, { width: 430, height: 932 }]) {
    await page.setViewportSize(viewport);
    const resizedTimeline = await page.locator(".session-timeline").boundingBox();
    const resizedComposer = await page.locator(".session-composer").boundingBox();
    expect((resizedTimeline?.y ?? 0) + (resizedTimeline?.height ?? 0)).toBeLessThanOrEqual((resizedComposer?.y ?? 0) + 1);
    expect((resizedComposer?.y ?? 0) + (resizedComposer?.height ?? 0)).toBeLessThanOrEqual(viewport.height + 1);
    await expectNoPageOverflow(page);
  }
  await page.setViewportSize({ width: 390, height: 844 });

  const editor = page.getByLabel("发送给 Codex");
  const initialEditorBox = await editor.boundingBox();
  expect(initialEditorBox?.height ?? 0).toBeGreaterThanOrEqual(44);
  expect(initialEditorBox?.height ?? 999).toBeLessThanOrEqual(56);
  await editor.fill(Array.from({ length: 16 }, (_, index) => `第 ${index + 1} 行移动输入`).join("\n"));
  const expandedEditorBox = await editor.boundingBox();
  expect(expandedEditorBox?.height ?? 0).toBeGreaterThan(initialEditorBox?.height ?? 0);
  expect(expandedEditorBox?.height ?? 999).toBeLessThanOrEqual(122);
  await editor.fill("");

  const infoButton = page.getByRole("button", { name: "查看会话信息" });
  const infoButtonBox = await infoButton.boundingBox();
  expect(infoButtonBox?.width ?? 0).toBeGreaterThanOrEqual(44);
  expect(infoButtonBox?.height ?? 0).toBeGreaterThanOrEqual(44);
  await infoButton.click();
  const infoDialog = page.getByRole("dialog", { name: "创建私人仓库并提交项目" });
  await expect(infoDialog).toBeVisible();
  await expect(infoDialog).toHaveCSS("opacity", "1");
  await expect(infoDialog.getByText(companyWorkspace)).toBeVisible();
  await expect(infoDialog.getByText(session.workstationName)).toBeVisible();
  await page.screenshot({ path: resolve(screenshots, "mobile-alpha-session-info.png"), fullPage: true });
  await page.keyboard.press("Escape");
  await expect(infoDialog).toBeHidden();
  await expect(infoButton).toBeFocused();

  await page.screenshot({ path: resolve(screenshots, "mobile-alpha-conversation-reworked.png"), fullPage: true });
  await expectNoPageOverflow(page);
  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);

  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator(".session-detail-pane")).toHaveCSS("transition-duration", "0s");
  await page.getByRole("button", { name: "返回会话列表" }).click();
  await expect(page.locator(".view-sessions .session-index")).toBeVisible();
  await expect(page.getByRole("log", { name: "Codex 会话消息" })).toBeHidden();
  await expect(sessionRow).toBeFocused();
  await expect(page.locator(".top-bar")).toBeVisible();
  await expect(page.locator(".bottom-nav")).toBeVisible();
});

test("active session messages commit once and retain text after a rejected send", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, "alice@yurupager.local");
  await selectWorkspace(page, companyWorkspace);
  const snapshot = await snapshotFromPage(page);
  const session = snapshot.sessions.find((item) => item.projectName === "YuruPager");
  if (session === undefined) throw new Error("YuruPager session is missing");

  let releaseFirst: (() => void) | undefined;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let submissions = 0;
  await page.route(`**/api/sessions/${session.id}/commands`, async (route) => {
    submissions += 1;
    if (submissions === 1) {
      await firstGate;
      const content = (route.request().postDataJSON() as { content: string }).content;
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({
          replayed: false,
          command: {
            id: "60000000-0000-4000-8000-000000000099",
            workspaceId: session.workspaceId,
            workstationId: session.workstationId,
            sessionId: session.id,
            actorName: "Alice Chen",
            status: "queued",
            contentLength: Array.from(content).length,
            turnId: null,
            errorCode: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            deliveredAt: null,
          },
        }),
      });
      return;
    }
    await route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "permission_denied", message: "denied" } }),
    });
  });

  await page.getByRole("button", { name: "会话", exact: true }).click();
  await page.locator(`[data-session-id="${session.id}"]`).click();
  const editor = page.getByLabel("发送给 Codex");
  await editor.fill("Continue with the deployment verification and report only the final status.");
  const send = page.getByRole("button", { name: "发送消息" });
  await send.evaluate((element: HTMLButtonElement) => { element.click(); element.click(); });
  await expect.poll(() => submissions).toBe(1);
  await expect(editor).toHaveValue("Continue with the deployment verification and report only the final status.");
  await expect(send).toBeDisabled();
  releaseFirst?.();
  await expect(page.getByText("消息已排队，等待工作站接收")).toBeVisible();
  await expect(editor).toHaveValue("");
  await page.locator(".session-records").evaluate((element: HTMLDetailsElement) => { element.open = true; });
  await expect(page.locator(".command-line").filter({ hasText: "等待工作站" })).toBeVisible();
  await expectStableLayer(page, ".snapshot-shell > .t-skel-content");
  await expectNoPageOverflow(page);
  await page.screenshot({ path: resolve(screenshots, "desktop-alpha-session-message.png"), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(editor).toBeVisible();
  const sendBox = await send.boundingBox();
  expect(sendBox?.height ?? 0).toBeGreaterThanOrEqual(44);
  await expect(page.getByText("消息已排队，等待工作站接收")).toBeHidden();
  await expectNoPageOverflow(page);
  await page.screenshot({ path: resolve(screenshots, "mobile-alpha-session-message.png"), fullPage: true });

  await editor.fill("Keep this text when permission is denied.");
  await send.click();
  await expect(page.locator(".session-composer .field-error")).toHaveText("你无权向此会话发送消息");
  await expect(editor).toHaveValue("Keep this text when permission is denied.");
  expect(submissions).toBe(2);
});

test("a queued remote text message is visible on desktop with its running and completed turn states", async ({ page }) => {
  await installConversationWebSocket(page);
  await page.route("**/api/snapshot*", async (route) => {
    const response = await route.fetch();
    const snapshot = await response.json() as Snapshot;
    await route.fulfill({
      response,
      json: {
        ...snapshot,
        sessions: snapshot.sessions.map((item) => item.projectName === "YuruPager" ? { ...item, status: "running" } : item),
      },
    });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, "alice@yurupager.local");
  await selectWorkspace(page, companyWorkspace);
  const snapshot = await snapshotFromPage(page);
  const session = snapshot.sessions.find((item) => item.projectName === "YuruPager");
  if (session === undefined) throw new Error("YuruPager session is missing");

  const remoteText = "请从手机继续检查这次部署。";
  let submittedContent: string | null = null;
  await page.route(`**/api/sessions/${session.id}/commands`, async (route) => {
    submittedContent = (route.request().postDataJSON() as { content: string }).content;
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        replayed: false,
        command: {
          id: "60000000-0000-4000-8000-000000000120",
          workspaceId: session.workspaceId,
          workstationId: session.workstationId,
          sessionId: session.id,
          actorName: "Alice Chen",
          status: "queued",
          contentLength: Array.from(remoteText).length,
          turnId: null,
          errorCode: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          deliveredAt: null,
        },
      }),
    });
  });

  await page.getByRole("button", { name: "会话", exact: true }).click();
  await page.locator(`[data-session-id="${session.id}"]`).click();
  const timeline = page.getByRole("log", { name: "Codex 会话消息" });
  await expect(timeline).toContainText("已完成端到端验证");

  const editor = page.getByLabel("发送给 Codex");
  await editor.fill(remoteText);
  await page.getByRole("button", { name: "排入下一轮" }).click();
  await expect.poll(() => submittedContent).toBe(remoteText);
  await expect(page.getByText("消息已排入下一轮")).toBeVisible();
  await expect(editor).toHaveValue("");

  await page.evaluate(({ sessionId, content }) => {
    window.dispatchEvent(new CustomEvent("yurupager:e2e-session-stream", {
      detail: {
        sessionId,
        frames: [
          { kind: "message.start", messageId: "remote-user", turnId: "remote-turn", role: "user" },
          { kind: "message.delta", messageId: "remote-user", delta: content },
          { kind: "message.complete", messageId: "remote-user" },
          { kind: "turn.status", turnId: "remote-turn", status: "in_progress" },
        ],
      },
    }));
  }, { sessionId: session.id, content: remoteText });
  await expect(timeline).toContainText(remoteText);
  await expect(page.getByRole("status", { name: "回合状态：当前回合运行中" })).toBeVisible();

  await page.evaluate(({ sessionId }) => {
    window.dispatchEvent(new CustomEvent("yurupager:e2e-session-stream", {
      detail: {
        sessionId,
        frames: [
          { kind: "message.start", messageId: "remote-assistant", turnId: "remote-turn", role: "assistant", phase: "final_answer" },
          { kind: "message.delta", messageId: "remote-assistant", delta: "远端回合已完成。" },
          { kind: "message.complete", messageId: "remote-assistant" },
          { kind: "turn.status", turnId: "remote-turn", status: "completed" },
        ],
      },
    }));
  }, { sessionId: session.id });
  await expect(timeline).toContainText("远端回合已完成。");
  await expect(page.getByRole("status", { name: "回合状态：上一回合已完成" })).toBeVisible();
});

test("Web and mobile PWA preview, remove and send an image-only Codex message", async ({ page }) => {
  await installConversationWebSocket(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, "alice@yurupager.local");
  await selectWorkspace(page, companyWorkspace);
  const snapshot = await snapshotFromPage(page);
  const session = snapshot.sessions.find((item) => item.projectName === "YuruPager");
  if (session === undefined) throw new Error("YuruPager session is missing");
  let submitted: { content: string; attachments: Array<{ ticket: string }> } | null = null;
  await page.route(`**/api/sessions/${session.id}/commands`, async (route) => {
    submitted = route.request().postDataJSON() as typeof submitted;
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        replayed: false,
        command: {
          id: "60000000-0000-4000-8000-000000000088",
          workspaceId: session.workspaceId,
          workstationId: session.workstationId,
          sessionId: session.id,
          actorName: "Alice Chen",
          status: "queued",
          contentLength: 0,
          turnId: null,
          errorCode: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          deliveredAt: null,
        },
      }),
    });
  });

  await page.getByRole("button", { name: "会话", exact: true }).click();
  await page.locator(`[data-session-id="${session.id}"]`).click();
  const picker = page.locator('.session-composer input[type="file"]');
  const image = {
    name: "must-not-leave-device.png",
    mimeType: "image/png",
    buffer: imageFixtureBytes,
  };
  await picker.setInputFiles(image);
  await expect(page.getByAltText("待发送图片 1")).toBeVisible();
  const remove = page.getByRole("button", { name: "移除待发送图片 1" });
  const removeBox = await remove.boundingBox();
  expect(removeBox?.width ?? 0).toBeGreaterThanOrEqual(44);
  expect(removeBox?.height ?? 0).toBeGreaterThanOrEqual(44);
  await expectNoPageOverflow(page);
  await page.screenshot({ path: resolve(screenshots, "desktop-alpha-image-upload.png"), fullPage: true });

  await remove.click();
  await expect(page.getByAltText("待发送图片 1")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "添加图片" })).toBeFocused();
  await picker.setInputFiles(image);
  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoPageOverflow(page);
  await page.screenshot({ path: resolve(screenshots, "mobile-alpha-image-upload.png"), fullPage: true });

  await page.getByRole("button", { name: "发送消息" }).click();
  await expect.poll(() => submitted).not.toBeNull();
  expect(submitted).toEqual({ content: "", attachments: [{ ticket: "e2e-signed-image-ticket" }] });
  expect(JSON.stringify(submitted)).not.toContain("must-not-leave-device.png");
  await expect(page.getByAltText("待发送图片 1")).toHaveCount(0);
  await expect(page.getByLabel("发送给 Codex")).toBeFocused();
  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
});

test("workstation pairing keeps registration separate from explicit authorization", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, "alice@yurupager.local");
  await selectWorkspace(page, companyWorkspace);
  let pairing: WorkstationPairingSummary | null = null;
  let creations = 0;
  let approvals = 0;
  await page.route("**/api/workstation-pairings**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ pairings: pairing === null ? [] : [pairing] }) });
      return;
    }
    if (url.pathname.endsWith("/approve")) {
      approvals += 1;
      pairing = { ...requirePairing(pairing), status: "approved", workstationId: "paired-workstation", approvedByName: "Alice Chen", updatedAt: new Date().toISOString() };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ pairing }) });
      return;
    }
    if (url.pathname.endsWith("/cancel")) {
      pairing = { ...requirePairing(pairing), status: "cancelled", updatedAt: new Date().toISOString() };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ pairing }) });
      return;
    }
    creations += 1;
    pairing = {
      id: "pairing-browser-test",
      workspaceId: "20000000-0000-4000-8000-000000000002",
      workspaceName: companyWorkspace,
      status: "waiting_for_device",
      deviceName: null,
      platform: null,
      connectorVersion: null,
      fingerprint: null,
      workstationId: null,
      createdByName: "Alice Chen",
      approvedByName: null,
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ pairing, pairCode: "ABCD-EFGH-JKLM", replayed: false }) });
  });

  await page.getByRole("button", { name: "工作站", exact: true }).click();
  const add = page.getByRole("button", { name: "添加", exact: true });
  await add.click();
  const dialog = page.getByRole("dialog", { name: "添加工作站" });
  await expect(dialog).toHaveClass(/is-open/);
  await page.getByRole("button", { name: "生成配对命令" }).click();
  expect(creations).toBe(1);
  await expect(dialog.locator(".pairing-command")).toContainText("ABCD-EFGH-JKLM");
  await expect(dialog.locator(".pairing-command")).not.toContainText("ypd_");

  pairing = {
    ...requirePairing(pairing),
    status: "pending_approval",
    deviceName: "Remote build host with a deliberately long device name for overflow verification",
    platform: "darwin 25.0 / arm64",
    connectorVersion: "0.2.0-alpha",
    fingerprint: "1234-5678-90AB-CDEF-1234-5678",
    updatedAt: new Date().toISOString(),
  };
  await expect(page.getByText("核对候选设备")).toBeVisible({ timeout: 4_000 });
  await expect(page.getByText("1234-5678-90AB-CDEF-1234-5678")).toBeVisible();
  await expectNoPageOverflow(page);
  await page.screenshot({ path: resolve(screenshots, "desktop-alpha-pairing.png"), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(dialog).toBeVisible();
  await expectNoPageOverflow(page);
  await page.screenshot({ path: resolve(screenshots, "mobile-alpha-pairing.png"), fullPage: true });
  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);

  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(dialog).toHaveCSS("transition-duration", "0s");
  await page.getByRole("button", { name: "确认连接" }).click();
  await expect(page.getByRole("heading", { name: "工作站已授权", exact: true })).toBeVisible();
  expect(approvals).toBe(1);
  await page.getByRole("button", { name: "完成" }).click();
  await expect(dialog).toBeHidden();
  await expect(add).toBeFocused();
});

test("edge viewports contain 200-character workspace, project, and command text", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await login(page, "alice@yurupager.local");
  await selectWorkspace(page, companyWorkspace);
  await expectStableLayer(page, ".snapshot-shell > .t-skel-content");
  await expectNoPageOverflow(page);

  const snapshot = await snapshotFromPage(page);
  const request = requireRequest(snapshot, (item) => item.risk === "high" && item.status === "pending");
  const longWorkspace = `Yuru global engineering workspace ${"with-explicit-ownership ".repeat(8)}`.slice(0, 200);
  const longProject = `YuruPager reliability verification project ${"with-a-long-name ".repeat(10)}`.slice(0, 200);
  const longCommand = `deploy --workspace ${"nested/path/with-a-long-segment/".repeat(8)} --confirm-owner-before-execution`;
  await page.route("**/api/snapshot*", async (route) => {
    const response = await route.fetch();
    const current = await response.json() as Snapshot;
    await route.fulfill({
      response,
      json: {
        ...current,
        workspaces: current.workspaces.map((workspace) => workspace.id === request.workspaceId ? { ...workspace, name: longWorkspace } : workspace),
        requests: current.requests.map((item) => item.id === request.id ? { ...item, workspaceName: longWorkspace, projectName: longProject, context: { ...item.context, command: longCommand } } : item),
      },
    });
  });

  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto(`/?view=inbox&request=${request.id}`);
  await expectStableLayer(page, ".detail-pane");
  await expect(page.getByRole("button", { name: "返回请求列表" })).toBeVisible();
  await expect(page.locator(".identity-strip").getByText(longWorkspace)).toBeVisible();
  await expect(page.getByRole("heading", { name: longProject })).toBeVisible();
  await expect(page.locator(".command-block code")).toHaveText(longCommand);
  await expectNoPageOverflow(page);
  await page.screenshot({ path: resolve(screenshots, "mobile-alpha-long-text.png"), fullPage: true });
});

test("mobile PWA restores its cached snapshot offline and preserves touch and focus targets", async ({ page, context }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, "alice@yurupager.local");
  await selectWorkspace(page, companyWorkspace);

  const manifest = await page.evaluate(async () => {
    const response = await fetch("/manifest.webmanifest");
    return response.json() as Promise<{ display: string; icons: Array<{ sizes: string }> }>;
  });
  expect(manifest.display).toBe("standalone");
  expect(manifest.icons.map((icon) => icon.sizes)).toEqual(expect.arrayContaining(["192x192", "512x512"]));
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await expect(page.getByRole("heading", { name: "请求", exact: true })).toBeVisible();
  expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);

  const row = page.locator(".request-row").filter({ hasText: "force-with-lease" });
  await row.click();
  await expect(page.locator(".inbox-workspace")).toHaveAttribute("data-page", "2");
  await expectStableLayer(page, ".detail-pane");
  const approve = page.getByRole("button", { name: "批准" });
  const deny = page.getByRole("button", { name: "拒绝" });
  for (const target of [approve, deny]) {
    const box = await target.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  }
  await expectNoPageOverflow(page);
  await page.screenshot({ path: resolve(screenshots, "mobile-alpha-request.png"), fullPage: true });

  await page.getByRole("button", { name: "返回请求列表" }).click();
  await expect(row).toBeFocused();
  await expectStableLayer(page, ".object-list-pane");
  await page.screenshot({ path: resolve(screenshots, "mobile-alpha-inbox.png"), fullPage: true });

  await context.setOffline(true);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "请求", exact: true })).toBeVisible();
  await row.click();
  await expect(page.getByRole("button", { name: "批准" })).toBeDisabled();
  await expect(page.getByText("当前离线。恢复服务器快照前无法提交决定。")).toBeVisible();
  await expect(page.locator(".t-skel-content")).toHaveCSS("opacity", "1");
  await expect(page.locator(".detail-pane")).toHaveCSS("opacity", "1");
  await page.screenshot({ path: resolve(screenshots, "mobile-alpha-offline.png"), fullPage: true });
  await context.setOffline(false);

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
});

async function login(page: Page, email: string): Promise<void> {
  await page.goto("/");
  await page.getByLabel("邮箱").fill(email);
  await page.getByLabel("密码").fill("alpha-demo");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByRole("heading", { name: "请求", exact: true })).toBeVisible();
}

async function selectWorkspace(page: Page, name: string): Promise<void> {
  const workspace = page.getByLabel("工作区", { exact: true });
  await workspace.selectOption({ label: name });
  await expect(workspace).toHaveValue("20000000-0000-4000-8000-000000000002");
  await expect(page.locator(".identity-strip").getByText(name)).toBeVisible();
}

async function snapshotFromPage(page: Page): Promise<Snapshot> {
  return page.evaluate(async () => {
    const response = await fetch("/api/snapshot?workspaceId=20000000-0000-4000-8000-000000000002");
    return response.json() as Promise<Snapshot>;
  });
}

function requireRequest(snapshot: Snapshot, predicate: (request: RequestSummary) => boolean): RequestSummary {
  const request = snapshot.requests.find(predicate);
  if (request === undefined) throw new Error("Required test request is missing");
  return request;
}

function requirePairing(pairing: WorkstationPairingSummary | null): WorkstationPairingSummary {
  if (pairing === null) throw new Error("Pairing fixture is missing");
  return pairing;
}

async function expectNoPageOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    main: document.querySelector("main") === null ? 0 : document.querySelector("main")!.scrollWidth - document.querySelector("main")!.clientWidth,
  }));
  expect(overflow.document).toBeLessThanOrEqual(0);
  expect(overflow.main).toBeLessThanOrEqual(0);
}

async function expectElementInsideViewport(page: Page, selector: string): Promise<void> {
  const bounds = await page.locator(selector).boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds?.x ?? -1).toBeGreaterThanOrEqual(0);
  expect(bounds?.y ?? -1).toBeGreaterThanOrEqual(0);
  expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(await page.evaluate(() => window.innerWidth));
  expect((bounds?.y ?? 0) + (bounds?.height ?? 0)).toBeLessThanOrEqual(await page.evaluate(() => window.innerHeight));
}

async function expectStableLayer(page: Page, selector: string): Promise<void> {
  const layer = page.locator(selector);
  await expect(layer).toHaveCSS("opacity", "1");
  await expect(layer).toHaveCSS("filter", "blur(0px)");
}

async function installConversationWebSocket(page: Page): Promise<void> {
  await page.addInitScript((fixture: { base64: string; byteLength: number; sha256: string }) => {
    const NativeEventTarget = window.EventTarget;
    const sockets = new Set<ConversationSocket>();
    class ConversationSocket extends NativeEventTarget {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readonly CONNECTING = 0;
      readonly OPEN = 1;
      readonly CLOSING = 2;
      readonly CLOSED = 3;
      readyState = ConversationSocket.CONNECTING;
      readonly url: string;
      protocol = "";
      extensions = "";
      binaryType: BinaryType = "blob";
      bufferedAmount = 0;
      onopen: ((this: WebSocket, ev: Event) => unknown) | null = null;
      onclose: ((this: WebSocket, ev: CloseEvent) => unknown) | null = null;
      onerror: ((this: WebSocket, ev: Event) => unknown) | null = null;
      onmessage: ((this: WebSocket, ev: MessageEvent) => unknown) | null = null;

      constructor(url: string | URL) {
        super();
        this.url = String(url);
        sockets.add(this);
        queueMicrotask(() => {
          this.readyState = ConversationSocket.OPEN;
          const opened = new Event("open");
          this.dispatchEvent(opened);
          this.onopen?.call(this as unknown as WebSocket, opened);
          this.emit({ type: "connected", userId: "10000000-0000-4000-8000-000000000001" });
          this.emit({ type: "session.titles.snapshot", titles: [{ sessionId: "40000000-0000-4000-8000-000000000001", title: "创建私人仓库并提交项目" }] });
        });
      }

      send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
        if (typeof data !== "string") return;
        const message = JSON.parse(data) as { type?: string; sessionId?: string; uploadId?: string; offset?: number; data?: string };
        if (message.type === "session.attachment.begin" && message.sessionId !== undefined && message.uploadId !== undefined) {
          queueMicrotask(() => this.emit({ type: "session.attachment.status", sessionId: message.sessionId, uploadId: message.uploadId, state: "accepted", nextOffset: 0 }));
          return;
        }
        if (message.type === "session.attachment.chunk" && message.sessionId !== undefined && message.uploadId !== undefined && message.offset !== undefined && message.data !== undefined) {
          const nextOffset = message.offset + atob(message.data).length;
          queueMicrotask(() => this.emit({ type: "session.attachment.status", sessionId: message.sessionId, uploadId: message.uploadId, state: "progress", nextOffset }));
          return;
        }
        if (message.type === "session.attachment.complete" && message.sessionId !== undefined && message.uploadId !== undefined) {
          queueMicrotask(() => this.emit({ type: "session.attachment.status", sessionId: message.sessionId, uploadId: message.uploadId, state: "ready", ticket: "e2e-signed-image-ticket" }));
          return;
        }
        if (message.type === "session.attachment.cancel" && message.sessionId !== undefined && message.uploadId !== undefined) {
          queueMicrotask(() => this.emit({ type: "session.attachment.status", sessionId: message.sessionId, uploadId: message.uploadId, state: "cancelled" }));
          return;
        }
        if (message.type !== "session.stream.subscribe" || message.sessionId === undefined) return;
        const sessionId = message.sessionId;
        const emit = (value: unknown) => this.emit(value);
        queueMicrotask(() => {
          emit({ type: "session.stream.status", sessionId, state: "loading" });
          emit({ type: "session.stream.frame", sessionId, frame: { kind: "history.start" } });
          emit({ type: "session.stream.frame", sessionId, frame: { kind: "message.start", messageId: "browser-user", turnId: "browser-turn", role: "user" } });
          emit({ type: "session.stream.frame", sessionId, frame: { kind: "message.delta", messageId: "browser-user", delta: "继续完成公网部署，并核对所有验证结果。" } });
          emit({ type: "session.stream.frame", sessionId, frame: { kind: "message.complete", messageId: "browser-user" } });
          emit({ type: "session.stream.frame", sessionId, frame: { kind: "activity.upsert", activityId: "browser-command", turnId: "browser-turn", activity: "command", label: "读取 main.mjs", status: "in_progress" } });
          emit({ type: "session.stream.frame", sessionId, frame: { kind: "activity.upsert", activityId: "browser-command", turnId: "browser-turn", activity: "command", label: "读取 main.mjs", status: "completed" } });
          emit({ type: "session.stream.frame", sessionId, frame: { kind: "activity.upsert", activityId: "browser-tool", turnId: "browser-turn", activity: "tool", label: "使用浏览器检查页面", status: "completed" } });
          emit({ type: "session.stream.frame", sessionId, frame: { kind: "activity.upsert", activityId: "browser-compaction", turnId: "browser-turn", activity: "context_compaction", label: "压缩上下文", status: "completed" } });
          emit({ type: "session.stream.frame", sessionId, frame: { kind: "image.start", imageId: "browser-image", turnId: "browser-turn", role: "assistant", mimeType: "image/png", byteLength: fixture.byteLength } });
          emit({ type: "session.stream.frame", sessionId, frame: { kind: "image.chunk", imageId: "browser-image", sequence: 0, data: fixture.base64 } });
          emit({ type: "session.stream.frame", sessionId, frame: { kind: "image.complete", imageId: "browser-image", sha256: fixture.sha256 } });
          emit({ type: "session.stream.frame", sessionId, frame: { kind: "message.start", messageId: "browser-agent", turnId: "browser-turn", role: "assistant", phase: "final_answer" } });
          emit({ type: "session.stream.frame", sessionId, frame: { kind: "message.delta", messageId: "browser-agent", delta: `<message><heartbeat>
# 每日中文重点简报 | 2026年8月14日

**已完成端到端验证。** 正文保持在工作站，浏览器只接收当前在线会话。

## 今日最重要的2件事

1. **DeepSeek 正式发布 V4 Pro。** 模型增强了 Agent 能力，并提供 API、App 和网页入口。[Reuters](https://www.reuters.com/world/china/deepseek-releases-official-v4-pro-model-it-steps-up-expansion-2026-08-13/)
2. **移动端渲染已校准。** 长链接、中文段落和列表不会遮挡输入区。

> 来源链接只允许安全的 HTTP 或 HTTPS 协议。

\`\`\`sh
npm run test:all
\`\`\`

${"long/path/segment/with-command-output-boundary ".repeat(18)}
</message></heartbeat>` } });
          emit({ type: "session.stream.frame", sessionId, frame: { kind: "message.complete", messageId: "browser-agent" } });
          emit({ type: "session.stream.frame", sessionId, frame: { kind: "history.complete" } });
          emit({ type: "session.stream.status", sessionId, state: "live" });
        });
      }

      close(): void {
        this.readyState = ConversationSocket.CLOSED;
        sockets.delete(this);
        this.dispatchEvent(new Event("close"));
      }

      emit(value: unknown): void {
        const event = new MessageEvent("message", { data: JSON.stringify(value) });
        this.dispatchEvent(event);
        this.onmessage?.call(this as unknown as WebSocket, event);
      }
    }
    window.addEventListener("yurupager:e2e-session-stream", (event) => {
      const detail = (event as CustomEvent<{ sessionId?: unknown; frames?: unknown }>).detail;
      if (typeof detail?.sessionId !== "string" || !Array.isArray(detail.frames)) return;
      for (const socket of sockets) {
        for (const frame of detail.frames) {
          socket.emit({ type: "session.stream.frame", sessionId: detail.sessionId, frame });
        }
      }
    });
    Object.defineProperty(window, "WebSocket", { configurable: true, value: ConversationSocket });
  }, imageFixture);
}
