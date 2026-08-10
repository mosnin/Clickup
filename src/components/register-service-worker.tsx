"use client";

import { useEffect } from "react";

// Registering a service worker is the easy half. The half that was missing is
// what made a shipped fix invisible to the people it was shipped for.
//
// A registration made once and never revisited is permanent: the browser only
// re-fetches `sw.js` on its own schedule, and a warm PWA — an icon on a phone
// home screen, a tab that is never closed — can go on serving a precached
// build for days. That is not theoretical. Three UI defects were fixed,
// deployed, and verified live in production's own stylesheet, while the
// founder's phone kept rendering the old shell and reporting them as broken.
// An update mechanism nobody triggers is the same as no update mechanism.
//
// Three things fix it, and all three are needed:
//
// 1. **Ask on every return.** `registration.update()` on mount and whenever
//    the tab becomes visible again. Cheap (a conditional request against
//    `sw.js`), and "they came back to the app" is exactly the moment a new
//    build should be discovered.
// 2. **Take over immediately.** The bundled worker already calls
//    `skipWaiting()`/`clientsClaim()`, so a downloaded worker activates
//    without waiting for every tab to close.
// 3. **Reload once when it does.** This is the part with no default: a new
//    worker controlling the page does NOT re-render what is already on
//    screen. Without a reload the reader keeps looking at the old HTML and
//    the old CSS until they happen to navigate. Guarded so it can only
//    happen once per page and never on first install (`controller` is null
//    then — reloading a first-time visitor is a flash for nothing).
export function RegisterServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;

    // Null on a first visit, set on every later one. The distinction is what
    // separates "a new build took over" from "the app just installed".
    const hadController = navigator.serviceWorker.controller !== null;
    let reloading = false;

    const onControllerChange = () => {
      if (!hadController || reloading) return;
      reloading = true;
      window.location.reload();
    };
    navigator.serviceWorker.addEventListener(
      "controllerchange",
      onControllerChange,
    );

    let registration: ServiceWorkerRegistration | undefined;
    const checkForUpdate = () => {
      // Failure here is always ignorable: offline, or the browser declining
      // to re-check this soon. The next visibility change asks again.
      registration?.update().catch(() => {});
    };

    navigator.serviceWorker
      .register("/sw.js")
      .then((reg) => {
        registration = reg;
        checkForUpdate();
      })
      .catch(() => {
        // Silently ignore — SW registration failure must not break the app.
      });

    const onVisible = () => {
      if (document.visibilityState === "visible") checkForUpdate();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      navigator.serviceWorker.removeEventListener(
        "controllerchange",
        onControllerChange,
      );
    };
  }, []);

  return null;
}
