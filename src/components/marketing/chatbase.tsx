"use client";

import { useEffect, useState } from "react";

// Chatbase support widget — logged-out site only (mounted in the marketing
// layout). The official embed auto-opens a bubble over the curl block and
// pricing tiers; we never load it until someone asks. A Help button in the
// corner is the intent. The embed still injects its launcher into <body>,
// OUTSIDE this component's tree, so cleanup on unmount (and the dashboard
// sweep) still matters.

const CHATBASE_ID = "2f2OJJtmJHQ_1vMk62-Id";

const CHATBASE_SELECTOR =
  '[id^="chatbase"], iframe[src*="chatbase.co"], script[src*="chatbase.co"]';

export function removeChatbaseNodes(): void {
  document
    .querySelectorAll(CHATBASE_SELECTOR)
    .forEach((node) => node.remove());
}

/* eslint-disable @typescript-eslint/no-explicit-any */
declare global {
  interface Window {
    chatbase?: any;
  }
}

function loadChatbase(): void {
  if (
    !window.chatbase ||
    window.chatbase("getState") !== "initialized"
  ) {
    const queued = (...args: any[]) => {
      if (!(queued as any).q) (queued as any).q = [];
      (queued as any).q.push(args);
    };
    window.chatbase = new Proxy(queued, {
      get(target: any, prop: string) {
        if (prop === "q") return target.q;
        return (...args: any[]) => target(prop, ...args);
      },
    });
  }
  if (!document.getElementById(CHATBASE_ID)) {
    const script = document.createElement("script");
    script.src = "https://www.chatbase.co/embed.min.js";
    script.id = CHATBASE_ID;
    (script as any).domain = "www.chatbase.co";
    document.body.appendChild(script);
  }
}

export function ChatbaseWidget() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    loadChatbase();
    return () => {
      removeChatbaseNodes();
      delete window.chatbase;
    };
  }, [open]);

  if (open) return null;

  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      className="fixed bottom-4 right-4 z-40 rounded-full bg-white px-4 py-2 text-sm font-medium text-navy-950 shadow-lg hover:bg-white/90"
    >
      Help
    </button>
  );
}
