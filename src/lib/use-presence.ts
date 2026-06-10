"use client";

import { useEffect, useRef } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";

const HEARTBEAT_MS = 10_000;

type FocusType = "task" | "doc" | "list" | "workspace" | "space";

// Heartbeats presence to Convex while the tab is focused on this entity,
// then returns the live list of *other* users currently looking. The
// hook handles:
//   - Visibility changes (`document.hidden`) — pause heartbeats so a
//     backgrounded tab doesn't claim presence.
//   - `pagehide` — fire a final clear so the avatar drops immediately
//     instead of waiting for the freshness window to expire.
//   - `typing` flag — pass-through; the chat composer pulses it.
//
// `enabled = false` short-circuits the whole thing; useful when a page
// renders the same component for both authed and unauth views.

export function usePresence({
  focusType,
  focusId,
  typing,
  enabled = true,
}: {
  focusType: FocusType;
  focusId: string | null | undefined;
  typing?: boolean;
  enabled?: boolean;
}) {
  const heartbeat = useMutation(api.presence.heartbeat);
  const clear = useMutation(api.presence.clear);
  const lastTypingRef = useRef<boolean | undefined>(undefined);

  // Skip the query when disabled or focusId isn't ready; the "skip"
  // sentinel keeps Convex from issuing the request.
  const viewers = useQuery(
    api.presence.listForFocus,
    enabled && focusId ? { focusType, focusId } : "skip",
  );

  useEffect(() => {
    if (!enabled || !focusId) return;
    let cancelled = false;

    function beat() {
      if (cancelled) return;
      if (typeof document !== "undefined" && document.hidden) return;
      heartbeat({ focusType, focusId: focusId as string, typing });
    }

    beat();
    const id = setInterval(beat, HEARTBEAT_MS);

    function onVisibility() {
      if (!document.hidden) beat();
    }
    function onHide() {
      clear({ focusType, focusId: focusId as string });
    }

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onHide);

    return () => {
      cancelled = true;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onHide);
      // Best-effort clear on unmount; failures are silent.
      clear({ focusType, focusId: focusId as string }).catch(() => {});
    };
  }, [enabled, focusType, focusId, heartbeat, clear, typing]);

  // Re-pulse immediately when `typing` flips so the indicator shows up
  // without waiting for the next 10s tick.
  useEffect(() => {
    if (!enabled || !focusId) return;
    if (lastTypingRef.current === typing) return;
    lastTypingRef.current = typing;
    heartbeat({ focusType, focusId: focusId as string, typing });
  }, [enabled, focusType, focusId, typing, heartbeat]);

  return viewers ?? [];
}
