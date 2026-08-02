"use client";

// Stamps `data-app="chat"` on the document root for as long as the Chat shell
// is mounted, and takes it off on the way out.
//
// On the root rather than on a wrapper div, because the things that most need
// to look like they belong to Chat — toasts, dropdowns, popovers, the command
// palette — render in portals attached to <body>, where a wrapper's attribute
// cannot reach them. A themed room with unthemed menus reads as a bug.
//
// It only writes this one attribute. Everything else on :root belongs to
// AppearanceProvider, and two writers fighting over the same element is how a
// personal accessibility setting gets silently overruled by a room's palette.

import { useEffect } from "react";

export function ChatThemeScope() {
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.app = "chat";
    return () => {
      delete root.dataset.app;
    };
  }, []);
  return null;
}
