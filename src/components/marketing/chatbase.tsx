"use client";

import { useEffect } from "react";

// Chatbase support widget — logged-out site only (mounted in the marketing
// layout). Faithful port of the official embed snippet: a queueing proxy
// stands in until embed.min.js loads, then the real client drains the
// queue. The widget renders its own launcher bottom-right.

const CHATBASE_ID = "2f2OJJtmJHQ_1vMk62-Id";

// The official snippet's shape: a callable that also carries a queue and
// arbitrary proxied methods — `any` is the honest type for a third-party
// global we don't own.
/* eslint-disable @typescript-eslint/no-explicit-any */
declare global {
  interface Window {
    chatbase?: any;
  }
}

export function ChatbaseWidget() {
  useEffect(() => {
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
    if (document.getElementById(CHATBASE_ID)) return;
    const script = document.createElement("script");
    script.src = "https://www.chatbase.co/embed.min.js";
    script.id = CHATBASE_ID;
    (script as any).domain = "www.chatbase.co";
    document.body.appendChild(script);
  }, []);

  return null;
}
