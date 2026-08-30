import { resolve } from "node:path";

import { chromium } from "playwright";

const appOrigin = requiredOrigin("YURUPAGER_PUBLIC_ORIGIN");
const previewOrigin = requiredOrigin("YURUPAGER_PREVIEW_ORIGIN");
const email = required("YURUPAGER_VERIFY_EMAIL");
const password = required("YURUPAGER_VERIFY_PASSWORD");
const routeId = required("YURUPAGER_VERIFY_ROUTE_ID");
const screenshotDirectory = resolve(process.env.YURUPAGER_SCREENSHOT_DIR ?? "artifacts/screenshots");

const targets = [
  {
    name: "desktop",
    viewport: { width: 1440, height: 900 },
    screenshot: resolve(screenshotDirectory, "public-desktop-port-preview.png"),
  },
  {
    name: "mobile",
    viewport: { width: 390, height: 844 },
    screenshot: resolve(screenshotDirectory, "public-mobile-port-preview.png"),
    isMobile: true,
    hasTouch: true,
  },
];

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH
    ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
});
try {
  const runs = await Promise.all(targets.map(async (target) => {
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: target.viewport,
      isMobile: target.isMobile ?? false,
      hasTouch: target.hasTouch ?? false,
      locale: "zh-CN",
    });
    const page = await context.newPage();
    const consoleErrors = [];
    const expectedApplicationErrors = [];
    const pageErrors = [];
    const failedRequests = [];
    const badResponses = [];
    const webSockets = [];

    page.on("console", (message) => {
      if (message.type() === "error") {
        const value = redact(message.text());
        if (isExpectedApplicationAuthError(value)) expectedApplicationErrors.push(value);
        else consoleErrors.push(value);
      }
    });
    page.on("pageerror", (error) => pageErrors.push(redact(error.message)));
    page.on("requestfailed", (request) => {
      failedRequests.push({ url: safeUrl(request.url()), error: request.failure()?.errorText ?? "unknown" });
    });
    page.on("response", (response) => {
      if (response.status() >= 400) {
        const item = { url: safeUrl(response.url()), status: response.status() };
        if (isExpectedApplicationAuthResponse(item)) expectedApplicationErrors.push(item);
        else badResponses.push(item);
      }
    });
    page.on("websocket", (socket) => webSockets.push(safeUrl(socket.url())));

    const login = await context.request.post(new URL("yurupager/api/auth/login", appOrigin).href, {
      data: { email, password },
      headers: { Origin: appOrigin.origin },
    });
    assertStatus(login, 200, `${target.name} login`);

    const snapshotResponse = await context.request.get(
      new URL("yurupager/api/snapshot?workspaceId=20000000-0000-4000-8000-000000000002", appOrigin).href,
    );
    assertStatus(snapshotResponse, 200, `${target.name} snapshot`);
    const snapshot = await snapshotResponse.json();
    const preview = snapshot.previews?.find((candidate) => candidate.routeId === routeId);
    if (preview === undefined) throw new Error(`${target.name}: active preview route was not present in the snapshot`);

    const launchResponse = await context.request.post(
      new URL(`yurupager/api/previews/${encodeURIComponent(preview.id)}/launch`, appOrigin).href,
      { data: {}, headers: { Origin: appOrigin.origin } },
    );
    assertStatus(launchResponse, 200, `${target.name} launch ticket`);
    const launch = await launchResponse.json();
    if (launch.gatewayOrigin !== previewOrigin.origin || typeof launch.ticket !== "string") {
      throw new Error(`${target.name}: launch response was not bound to the expected gateway`);
    }

    const redeem = await context.request.post(new URL("__yurupager/open", previewOrigin).href, {
      form: { ticket: launch.ticket },
    });
    assertStatus(redeem, 200, `${target.name} ticket redemption`);

    return { context, page, target, consoleErrors, expectedApplicationErrors, pageErrors, failedRequests, badResponses, webSockets };
  }));

  await Promise.all(runs.map(async (run) => {
    const response = await run.page.goto(previewOrigin.href, { waitUntil: "domcontentloaded", timeout: 45_000 });
    if (response === null || response.status() !== 200) {
      throw new Error(`${run.target.name}: preview navigation returned ${response?.status() ?? "no response"}`);
    }
  }));

  await Promise.all(runs.map(async (run) => {
    await run.page.waitForFunction(() => {
      const root = document.querySelector("#root");
      return root !== null && root.childElementCount > 0 && root.getBoundingClientRect().height > 100;
    }, undefined, { timeout: 45_000 });
    await run.page.waitForTimeout(2_500);
    await run.page.screenshot({ path: run.target.screenshot, fullPage: true });
  }));

  const reports = await Promise.all(runs.map(async (run) => {
    const layout = await run.page.evaluate(() => {
      const root = document.querySelector("#root");
      const rootBox = root?.getBoundingClientRect();
      return {
        title: document.title,
        language: document.documentElement.lang,
        bodyTextLength: document.body.innerText.trim().length,
        rootChildren: root?.childElementCount ?? 0,
        rootWidth: Math.round(rootBox?.width ?? 0),
        rootHeight: Math.round(rootBox?.height ?? 0),
        horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        background: getComputedStyle(document.body).backgroundColor,
      };
    });
    const hmrConnected = run.webSockets.some((url) => url.startsWith("wss://") && url.includes(previewOrigin.host));
    const expectedResponseErrors = run.expectedApplicationErrors.filter((item) => typeof item === "object").length;
    let expectedConsoleErrors = 0;
    const unexpectedConsoleErrors = run.consoleErrors.filter((message) => {
      const isGenericForbidden = message.includes("Failed to load resource: the server responded with a status of 403");
      if (isGenericForbidden && expectedConsoleErrors < expectedResponseErrors) {
        expectedConsoleErrors += 1;
        return false;
      }
      return true;
    });
    return {
      target: run.target.name,
      viewport: run.target.viewport,
      finalUrl: safeUrl(run.page.url()),
      screenshot: run.target.screenshot,
      layout,
      hmrConnected,
      badResponses: run.badResponses,
      failedRequests: run.failedRequests,
      consoleErrors: unexpectedConsoleErrors,
      expectedConsoleErrors,
      pageErrors: run.pageErrors,
      expectedApplicationErrors: run.expectedApplicationErrors,
    };
  }));

  for (const report of reports) {
    if (report.layout.bodyTextLength === 0 || report.layout.rootChildren === 0 || report.layout.rootHeight <= 100) {
      throw new Error(`${report.target}: preview rendered an empty root`);
    }
    if (report.layout.horizontalOverflow > 0) {
      throw new Error(`${report.target}: page overflowed horizontally by ${report.layout.horizontalOverflow}px`);
    }
    if (!report.hmrConnected) throw new Error(`${report.target}: Vite HMR WebSocket did not connect`);
    if (report.badResponses.some(({ status }) => status === 502)) {
      throw new Error(`${report.target}: preview returned a 502 response`);
    }
    if (report.failedRequests.length > 0 || report.consoleErrors.length > 0 || report.pageErrors.length > 0) {
      throw new Error(`${report.target}: browser errors were observed\n${JSON.stringify(report, null, 2)}`);
    }
  }

  process.stdout.write(`${JSON.stringify({ routeId, reports }, null, 2)}\n`);
  await Promise.all(runs.map(({ context }) => context.close()));
} finally {
  await browser.close();
}

function required(name) {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") throw new Error(`${name} is required`);
  return value;
}

function requiredOrigin(name) {
  const url = new URL(required(name));
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    throw new Error(`${name} must be an HTTPS origin without credentials`);
  }
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url;
}

function assertStatus(response, expected, operation) {
  if (response.status() !== expected) {
    throw new Error(`${operation} returned ${response.status()}`);
  }
}

function safeUrl(value) {
  const url = new URL(value);
  url.search = "";
  url.hash = "";
  return url.href;
}

function isExpectedApplicationAuthResponse({ url, status }) {
  return (status === 401 || status === 403) && /\/api\/v1\/auth\/(public-config|feishu\/config)$/.test(url);
}

function isExpectedApplicationAuthError(value) {
  return value.includes("/api/v1/auth/public-config") || value.includes("/api/v1/auth/feishu/config");
}

function redact(value) {
  return value.replaceAll(password, "[REDACTED]");
}
