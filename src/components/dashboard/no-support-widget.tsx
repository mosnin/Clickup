"use client";

import { useEffect } from "react";
import { removeChatbaseNodes } from "@/components/marketing/chatbase";

// The support chat belongs to the logged-out site only. Its embed injects a
// launcher straight into <body>, and it can finish loading AFTER a
// client-side navigation into the app — at which point React has already
// unmounted the marketing layout and its cleanup has run, so nothing else
// would take the widget down. This sweeps on mount and keeps watching
// <body> for late arrivals while the dashboard is open.

export function NoSupportWidget() {
  useEffect(() => {
    removeChatbaseNodes();
    const observer = new MutationObserver(() => removeChatbaseNodes());
    // childList on <body> only: the embed appends at the top level, so there
    // is no reason to pay for a subtree observer over the whole app.
    observer.observe(document.body, { childList: true });
    return () => observer.disconnect();
  }, []);

  return null;
}
