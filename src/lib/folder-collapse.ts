"use client";

import { useCallback, useEffect, useState } from "react";

// Per-folder open/closed memory, persisted the same way the sidebar
// persists its own collapsed state: a plain cookie, no store, no server
// round-trip. Both surfaces that render folders (the sidebar tree and the
// Space page) read the same cookie, so collapsing a folder in one place
// keeps it collapsed in the other.
//
// The cookie holds the ids that are CLOSED — folders default to open, so
// the common case costs zero bytes and the cookie stays bounded by how
// many folders a user has deliberately collapsed.

const COOKIE_NAME = "folder_closed";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30;
const MAX_IDS = 200;

// One module-level cache + subscriber set: every folder row shares the
// parsed value, so toggling one row re-renders the others that care
// without each of them re-parsing document.cookie.
let cache: Set<string> | null = null;
const listeners = new Set<() => void>();

function read(): Set<string> {
  if (cache) return cache;
  if (typeof document === "undefined") return new Set();
  const raw = document.cookie
    .split("; ")
    .find((c) => c.startsWith(`${COOKIE_NAME}=`))
    ?.slice(COOKIE_NAME.length + 1);
  cache = new Set(
    raw ? decodeURIComponent(raw).split(",").filter(Boolean) : [],
  );
  return cache;
}

function write(next: Set<string>) {
  cache = next;
  if (typeof document !== "undefined") {
    // Cap the list so a long-lived account can't grow an unbounded cookie;
    // the oldest entries fall off first.
    const ids = [...next].slice(-MAX_IDS);
    document.cookie = `${COOKIE_NAME}=${encodeURIComponent(
      ids.join(","),
    )}; path=/; max-age=${COOKIE_MAX_AGE}; samesite=lax`;
  }
  for (const fn of listeners) fn();
}

/**
 * `[expanded, toggle]` for one folder id, persisted across reloads.
 *
 * Reads lazily on mount rather than during the server render: folder rows
 * only exist once the Convex tree query resolves (client-side), so there
 * is no hydration mismatch to guard against.
 */
export function useFolderExpanded(
  folderId: string,
): [boolean, (next?: boolean) => void] {
  const [closed, setClosed] = useState(false);

  useEffect(() => {
    const sync = () => setClosed(read().has(folderId));
    sync();
    listeners.add(sync);
    return () => {
      listeners.delete(sync);
    };
  }, [folderId]);

  // `next` is the desired EXPANDED state; omit it to flip.
  const toggle = useCallback(
    (next?: boolean) => {
      const current = read();
      const wantExpanded = next ?? current.has(folderId);
      const set = new Set(current);
      if (wantExpanded) set.delete(folderId);
      else set.add(folderId);
      write(set);
    },
    [folderId],
  );

  return [!closed, toggle];
}
