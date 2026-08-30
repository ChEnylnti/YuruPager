const CACHE = "yurupager-shell-v5";
const SCOPE = new URL(self.registration.scope).pathname;
const BASE = SCOPE.endsWith("/") ? SCOPE : `${SCOPE}/`;
const scopedUrl = (path = "") => `${BASE}${path.replace(/^\/+/, "")}`;
const SHELL = [scopedUrl(), scopedUrl("manifest.webmanifest"), scopedUrl("icons/icon-192.png"), scopedUrl("icons/icon-512.png")];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;
  if (new URL(request.url).pathname.startsWith(scopedUrl("api/"))) return;
  event.respondWith(
    fetch(request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(request, copy));
        return response;
      })
      .catch(() => caches.match(request).then((cached) => cached ?? caches.match(scopedUrl()))),
  );
});

self.addEventListener("push", (event) => {
  const data = readPushData(event.data);
  const requestId = typeof data.requestId === "string" && data.requestId.length <= 200
    ? data.requestId
    : null;
  event.waitUntil(
    self.registration.showNotification("YuruPager 有新的待办", {
      body: "打开应用查看当前状态。",
      icon: scopedUrl("icons/icon-192.png"),
      badge: scopedUrl("icons/icon-192.png"),
      tag: requestId ?? "yurupager",
      data: { url: requestId ? `${scopedUrl()}?view=inbox&request=${encodeURIComponent(requestId)}` : `${scopedUrl()}?view=inbox` },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = event.notification.data?.url ?? `${scopedUrl()}?view=inbox`;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      const client = clients.find((candidate) => new URL(candidate.url).pathname.startsWith(BASE));
      return client ? client.navigate(target).then(() => client.focus()) : self.clients.openWindow(target);
    }),
  );
});

function readPushData(data) {
  if (data === null) return {};
  try {
    const value = data.json();
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}
