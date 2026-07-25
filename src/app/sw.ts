/// <reference lib="webworker" />
//
// Service-worker source compiled by @serwist/next into public/sw.js at
// build time. Don't import client-side code here — only worker globals
// and Serwist-friendly modules are available.
//
// What this gives us out of the box:
//   - Precaches the Next.js build manifest (static assets + RSC).
//   - Network-first navigation with an offline fallback to the last
//     successful HTML response.
//   - Stale-while-revalidate for images, fonts, and same-origin
//     scripts (defaultCache from @serwist/next/worker).
//
// Convex's WebSocket is left untouched — it's not cacheable and bypasses
// fetch() anyway, so live queries work the moment the network returns.

import { defaultCache } from "@serwist/next/worker";
import type { PrecacheEntry, SerwistGlobalConfig } from "serwist";
import { NetworkOnly, Serwist } from "serwist";

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

declare const self: ServiceWorkerGlobalScope;

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  runtimeCaching: [
    // Video must bypass the service worker entirely. A cached video is
    // served back as a complete 200 response, but Safari (and iOS in
    // particular) plays media by issuing byte-range requests and refuses
    // anything that answers a Range request with a full body — which shows
    // up as a video that silently never starts. NetworkOnly lets the
    // browser talk to the network directly and negotiate 206s itself.
    // This entry is FIRST because Serwist takes the first matching route.
    {
      matcher: ({ request, url }) =>
        request.destination === "video" ||
        /\.(?:mp4|webm|mov)$/i.test(url.pathname),
      handler: new NetworkOnly(),
    },
    ...defaultCache,
  ],
});

serwist.addEventListeners();
