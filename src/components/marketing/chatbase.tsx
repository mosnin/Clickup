"use client";

import { useEffect } from "react";

// Chatbase support widget — logged-out site only (mounted in the marketing
// layout). Faithful port of the official embed snippet: a queueing proxy
// stands in until embed.min.js loads, then the real client drains the
// queue. The widget renders its own launcher bottom-right.
//
// The embed injects its launcher into <body>, OUTSIDE this component's tree,
// so React unmounting the marketing layout does not remove it. Navigating
// from a marketing page into /dashboard is a client-side transition, which
// left the support bubble floating over the app. The cleanup below tears the
// widget down on unmount, and `removeChatbaseNodes` is exported so the
// dashboard shell can sweep up anything the embed injects asynchronously
// after we've already navigated away.

const CHATBASE_ID = "2f2OJJtmJHQ_1vMk62-Id";

// Everything the embed puts in the document: its own script tag, the
// launcher/window nodes (all id-prefixed "chatbase"), and the iframe it
// renders the conversation in.
const CHATBASE_SELECTOR =
  '[id^="chatbase"], iframe[src*="chatbase.co"], script[src*="chatbase.co"]';

export function removeChatbaseNodes(): void {
  document
    .querySelectorAll(CHATBASE_SELECTOR)
    .forEach((node) => node.remove());
}

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
    if (!document.getElementById(CHATBASE_ID)) {
      const script = document.createElement("script");
      script.src = "https://www.chatbase.co/embed.min.js";
      script.id = CHATBASE_ID;
      (script as any).domain = "www.chatbase.co";
      document.body.appendChild(script);
    }

    return () => {
      // Leaving the logged-out site takes the widget with it. The global is
      // cleared too, so a later return to marketing re-runs the real init
      // instead of finding a stale "initialized" client with no DOM.
      removeChatbaseNodes();
      delete window.chatbase;
    };
  }, []);

  return null;
}
