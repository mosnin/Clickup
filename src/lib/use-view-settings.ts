"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import {
  DEFAULT_VIEW_SETTINGS,
  hasViewSettingsParams,
  isCustomized,
  normalizeViewSettings,
  parseViewSettings,
  writeViewSettingsToParams,
  type ViewSettings,
} from "./view-settings";

// Per-list view customization state (see view-settings.ts for the contract).
//
// Precedence, highest first:
//   1. The URL (`?vs=`/`?vf=`) — a shared link reproduces exactly what the
//      sender saw, for whoever opens it.
//   2. The server (`userSettings.listViewSettings`) — your own setup, so it
//      follows you to another device or another browser.
//   3. localStorage for this browser — the offline/logged-out fallback, and
//      what renders first on a cold load while the server value is in flight.
//
// Every change writes all three. The server write is debounced (toggling a
// row of switches shouldn't be a row of mutations) and is skipped entirely
// while auth is loading or absent — a logged-out visitor must never clobber
// the stored settings of whoever logs in next.

const STORAGE_PREFIX = "operate.view-settings.";
const SERVER_WRITE_DEBOUNCE_MS = 800;

function storageKey(listId: string) {
  return `${STORAGE_PREFIX}${listId}`;
}

function readStored(listId: string): ViewSettings | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(storageKey(listId));
    if (!raw) return null;
    return normalizeViewSettings(JSON.parse(raw));
  } catch {
    // Private mode, quota errors, or a corrupt payload — fall back silently.
    return null;
  }
}

function writeStored(listId: string, settings: ViewSettings) {
  if (typeof window === "undefined") return;
  try {
    if (!isCustomized(settings)) {
      window.localStorage.removeItem(storageKey(listId));
      return;
    }
    window.localStorage.setItem(storageKey(listId), JSON.stringify(settings));
  } catch {
    // Nothing to do — the URL still carries the state for this session.
  }
}

/** The stored form: the same `vs`/`vf` encoding the URL carries. */
export function encodeViewSettings(settings: ViewSettings): string {
  return writeViewSettingsToParams(new URLSearchParams(), settings).toString();
}

export function decodeViewSettings(encoded: string): ViewSettings {
  return parseViewSettings(new URLSearchParams(encoded));
}

export type UseViewSettings = {
  settings: ViewSettings;
  /** Patch one or more settings; writes the URL, localStorage, and server. */
  update: (patch: Partial<ViewSettings>) => void;
  /** Back to the out-of-the-box view. */
  reset: () => void;
  /** True when anything differs from the defaults. */
  customized: boolean;
};

export function useViewSettings(listId: string): UseViewSettings {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { isAuthenticated } = useConvexAuth();

  // localStorage can only be read after mount — reading it during render
  // would desync the server-rendered HTML from the first client paint.
  const [stored, setStored] = useState<ViewSettings | null>(null);
  useEffect(() => setStored(readStored(listId)), [listId]);

  // `undefined` while the subscription is in flight, `null` when logged out
  // or when this user has no settings row yet. Both mean "don't know", never
  // "no preference" — so neither can overwrite what's stored.
  const userSettings = useQuery(
    api.userSettings.current,
    isAuthenticated ? {} : "skip",
  );
  const persist = useMutation(api.userSettings.setListViewSettings);

  const fromServer = useMemo(() => {
    const row = userSettings?.listViewSettings?.find(
      (entry) => entry.listId === listId,
    );
    return row ? decodeViewSettings(row.settings) : null;
  }, [userSettings, listId]);

  const fromUrl = useMemo(
    () => (hasViewSettingsParams(searchParams) ? parseViewSettings(searchParams) : null),
    [searchParams],
  );

  const settings = fromUrl ?? fromServer ?? stored ?? DEFAULT_VIEW_SETTINGS;

  // A debounced write-through, flushed on unmount so the last toggle before
  // navigating away still lands.
  const pending = useRef<{ listId: string; encoded: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const persistRef = useRef(persist);
  persistRef.current = persist;

  const flush = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const job = pending.current;
    pending.current = null;
    if (!job) return;
    // A failed write is not worth interrupting anyone over: the URL and
    // localStorage already hold the same state.
    void persistRef
      .current({ listId: job.listId as Id<"lists">, settings: job.encoded })
      .catch(() => {});
  }, []);

  useEffect(() => flush, [flush]);

  const commit = useCallback(
    (next: ViewSettings) => {
      setStored(next);
      writeStored(listId, next);
      const params = writeViewSettingsToParams(
        new URLSearchParams(searchParams.toString()),
        next,
      );
      const qs = params.toString();
      // replace, not push: tweaking a toggle shouldn't fill the back stack.
      router.replace(qs ? `?${qs}` : "?", { scroll: false });

      if (!isAuthenticated) return;
      pending.current = { listId, encoded: encodeViewSettings(next) };
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(flush, SERVER_WRITE_DEBOUNCE_MS);
    },
    [flush, isAuthenticated, listId, router, searchParams],
  );

  const update = useCallback(
    (patch: Partial<ViewSettings>) => commit({ ...settings, ...patch }),
    [commit, settings],
  );

  const reset = useCallback(
    () => commit({ ...DEFAULT_VIEW_SETTINGS }),
    [commit],
  );

  return {
    settings,
    update,
    reset,
    customized: isCustomized(settings),
  };
}
