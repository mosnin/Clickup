"use client";

import { useEffect, useRef } from "react";

// Unicorn Studio scene behind the hero — the vendor's embed, wrapped so it
// survives client-side navigation.
//
// The stock snippet injects its script once and calls UnicornStudio.init()
// from the script's onload. That is fine on a hard load, but this is a
// Next.js app: navigating away unmounts the container and coming back mounts
// a fresh one, at which point the script is already present and its onload
// will never fire again — the scene would simply never appear. So mounting
// re-runs init() when the library is already loaded, and unmounting tears the
// scene down rather than leaving an orphaned WebGL context behind.

const PROJECT_ID = "PbfL8YshrLU8GjeTZ4HP";
const SCRIPT_ID = "unicornstudio-embed";
const SRC =
  "https://cdn.jsdelivr.net/gh/hiunicornstudio/unicornstudio.js@v2.1.0-1/dist/unicornStudio.umd.js";

// A third-party global we do not own; `any` is the honest type here.
/* eslint-disable @typescript-eslint/no-explicit-any */
declare global {
  interface Window {
    UnicornStudio?: any;
  }
}

export function HeroUnicorn() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const init = () => {
      try {
        window.UnicornStudio?.init?.();
        if (window.UnicornStudio) window.UnicornStudio.isInitialized = true;
      } catch {
        // A failed scene must never take the hero down with it — the black
        // canvas underneath is a perfectly good fallback.
      }
    };

    if (window.UnicornStudio?.isInitialized) {
      // Library already loaded by an earlier visit to this page.
      init();
    } else if (!document.getElementById(SCRIPT_ID)) {
      window.UnicornStudio = window.UnicornStudio ?? { isInitialized: false };
      const script = document.createElement("script");
      script.id = SCRIPT_ID;
      script.src = SRC;
      script.async = true;
      script.onload = init;
      document.head.appendChild(script);
    } else {
      // Script tag exists but has not finished loading yet.
      document.getElementById(SCRIPT_ID)?.addEventListener("load", init, {
        once: true,
      });
    }

    return () => {
      try {
        window.UnicornStudio?.destroy?.();
        if (window.UnicornStudio) window.UnicornStudio.isInitialized = false;
      } catch {
        // Ignore: nothing useful to do if the vendor teardown throws.
      }
    };
  }, []);

  return (
    <div
      ref={ref}
      data-us-project={PROJECT_ID}
      className="absolute left-0 top-0 h-full w-full"
    />
  );
}
