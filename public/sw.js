// Minimal service worker — enough for PWA installability without enforcing
// any caching strategy. When you're ready for offline support, swap this
// for Workbox or @serwist/next.
const CACHE_NAME = "clickup-clone-v1";
const PRECACHE_URLS = ["/"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)),
      ),
    ),
  );
  self.clients.claim();
});

// Network-first for navigation requests so users always get fresh HTML;
// fall back to cached "/" only if the network is unreachable.
self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.mode !== "navigate") return;

  event.respondWith(
    fetch(request).catch(() =>
      caches.match("/").then((cached) => cached ?? Response.error()),
    ),
  );
});
