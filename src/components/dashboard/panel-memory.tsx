"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { AnimatePresence, motion } from "motion/react";
import { api } from "@convex/_generated/api";
import { EASE } from "@/components/motion";
import {
  normalizeWatch,
  readPanelState,
  shouldRemember,
  type Memory,
  type PanelState,
} from "@/lib/panel-memory";
import { cn } from "@/lib/utils";

// The panel says what changed.
//
// Everything here hangs off one stored number per panel per person: the value
// it last showed *you*. That is the whole mechanism. No cron, no background
// job, no second query — the panel already fetched the number, and comparing
// it to what you last saw is arithmetic.
//
// The subtle part is *when to write*. Writing on every render overwrites the
// very thing the delta is measured against, and the panel reports "no change"
// forever while looking like it works. So a memory is written only once the
// reader has genuinely had a chance to see the value: a few seconds of dwell,
// and only when it differs from what is stored. `shouldRemember` owns that
// rule and is tested against it.
//
// The other restraint worth naming: a dashboard where everything announces
// itself is a dashboard where nothing does. A panel that has not moved says
// nothing at all — no "no change since yesterday", no neutral badge. Silence
// is the default and it carries information.

/**
 * What a panel currently knows about itself.
 *
 * Returns the state *and* the writer, so a panel can render the sentence and
 * record the visit without knowing anything about how either works.
 */
export function usePanelMemory(
  panelId: string | null,
  value: number | null,
): PanelState | null {
  const remote = useQuery(api.appearance.forCurrentUser, {});
  const remember = useMutation(api.appearance.rememberPanel);
  // When this reading appeared on screen — the clock the dwell is measured
  // against. A ref rather than state: it must not cause a render, and it has
  // to reset whenever the value changes underneath.
  const shownAt = useRef(Date.now());
  const lastValue = useRef<number | null>(null);
  if (lastValue.current !== value) {
    lastValue.current = value;
    shownAt.current = Date.now();
  }

  const memory = useMemo<Memory | null>(() => {
    if (!remote || !panelId) return null;
    const stored = (remote.panelMemory ?? {})[panelId] as
      | { value?: unknown; seenAt?: unknown }
      | undefined;
    if (
      !stored ||
      typeof stored.value !== "number" ||
      typeof stored.seenAt !== "number"
    ) {
      return null;
    }
    return { value: stored.value, seenAt: stored.seenAt };
  }, [remote, panelId]);

  const watch = useMemo(() => {
    if (!remote || !panelId) return null;
    return normalizeWatch((remote.panelWatches ?? {})[panelId]);
  }, [remote, panelId]);

  const state = useMemo(() => {
    if (value === null) return null;
    return readPanelState({ value, memory, watch });
  }, [value, memory, watch]);

  // Record the visit, once the reader has had a moment with it.
  useEffect(() => {
    if (!panelId || value === null || remote === undefined) return;
    const timer = setTimeout(() => {
      if (
        shouldRemember({ value, memory, shownAt: shownAt.current })
      ) {
        void remember({ panelId, value, seenAt: Date.now() }).catch(() => {
          // A memory that did not save costs one delta. Not worth a toast.
        });
      }
    }, 4_200);
    return () => clearTimeout(timer);
  }, [panelId, value, memory, remote, remember]);

  return state;
}

/**
 * The sentence, under the number.
 *
 * Absent when there is nothing to say, which is most of the time and by
 * design. A badge that reads "no change" on forty panels is forty pieces of
 * furniture and no information.
 */
export function PanelDelta({
  state,
  className,
}: {
  state: PanelState | null;
  className?: string;
}) {
  const message = state?.message ?? "";
  return (
    <AnimatePresence initial={false} mode="wait">
      {message && (
        <motion.p
          key={message}
          initial={{ opacity: 0, y: -3 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 3 }}
          transition={{ duration: 0.25, ease: EASE }}
          aria-live="polite"
          className={cn(
            "text-tiny leading-snug",
            state?.tone === "alert"
              ? "font-medium text-foreground"
              : "text-muted-foreground",
            className,
          )}
        >
          {message}
        </motion.p>
      )}
    </AnimatePresence>
  );
}

/**
 * A panel that has something to say leans forward slightly.
 *
 * Weight rather than movement, deliberately. A layout that rearranges itself
 * by urgency is a layout you have to re-learn every morning — the panel stays
 * exactly where you put it and only changes how much it insists. `note` is a
 * hairline; `alert` is a ring you cannot miss. Nothing here animates on a
 * loop: a pulsing panel is a panel you cover with a sticky note.
 */
export function panelAttentionClass(state: PanelState | null): string {
  if (!state?.tripped) return "";
  return state.tone === "alert"
    ? "ring-2 ring-foreground"
    : "ring-1 ring-muted-foreground/40";
}

/** The control that sets a watch, for the inspector. */
export function useSetPanelWatch() {
  const setWatch = useMutation(api.appearance.setPanelWatch);
  return (panelId: string, watch: unknown) => {
    void setWatch({ panelId, watch: watch ?? undefined }).catch(() => {});
  };
}

/** Everything a panel needs, in one call. */
export function usePanelAttention(panelId: string | null, value: number | null) {
  const state = usePanelMemory(panelId, value);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return {
    state,
    // Server and client disagree about `Date.now()`, and a delta rendered
    // during hydration is a hydration mismatch. Hold it until mounted.
    ready: mounted,
    attentionClass: mounted ? panelAttentionClass(state) : "",
  };
}
