"use client";

import { useEffect, useRef } from "react";
import { useUser } from "@clerk/nextjs";
import { useMutation, useQuery } from "convex/react";
import { AnimatePresence, motion } from "motion/react";
import { api } from "@convex/_generated/api";
import { EASE, SPRING } from "@/components/motion";
import { traceEdge } from "@/lib/anime";
import { cn } from "@/lib/utils";

// Who else is here — people and agents in one rail.
//
// The point of this component is the second half. An agent's work used to be
// *reported*: a heartbeat and a status line on a dashboard about agents, while
// the page it was rewriting showed no sign of anything happening. Presence is
// what turns that into a colleague — you open a task and something is already
// there, working, with its own name on it.
//
// So agents are not styled as a lesser class of participant. They get the same
// chip a person gets, in the same rail, sorted first because a machine at work
// is the news. What distinguishes them is a ring that pulses while they write,
// which is the honest signal: this one is moving.
//
// Arrivals and departures animate. A rail that swaps contents instantly reads
// as a rendering artifact; someone appearing should look like someone arriving.

export type PresenceSurface = "page" | "task" | "list" | "project" | "space";

/**
 * Announce that you are here, every 20 seconds.
 *
 * Two thirds of the 45-second window, so one dropped beat never makes you
 * vanish from someone else's rail. Stops when the tab is hidden — a backgrounded
 * tab is not someone looking at the page, and claiming otherwise is how presence
 * indicators become noise nobody trusts.
 */
export function usePresence(
  surfaceType: PresenceSurface,
  surfaceId: string | null,
  editing = false,
): void {
  const heartbeat = useMutation(api.presence.heartbeat);
  const leave = useMutation(api.presence.leave);
  const { user } = useUser();
  const name = user?.firstName || user?.fullName || "Someone";
  // Held in a ref so a change of `editing` doesn't restart the interval — it
  // should take effect on the next beat, not reset the clock.
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const nameRef = useRef(name);
  nameRef.current = name;

  useEffect(() => {
    if (!surfaceId) return;
    let timer: ReturnType<typeof setInterval> | null = null;

    const beat = () => {
      if (document.hidden) return;
      void heartbeat({
        surfaceType,
        surfaceId,
        name: nameRef.current,
        editing: editingRef.current,
      }).catch(() => {
        // Presence is decoration on a real page. A failed beat costs a dot.
      });
    };

    beat();
    timer = setInterval(beat, 20_000);
    return () => {
      if (timer) clearInterval(timer);
      // Leaving explicitly rather than waiting out the window: closing a tab
      // should empty your seat now, not in forty-five seconds.
      void leave({ surfaceType, surfaceId }).catch(() => {});
    };
  }, [heartbeat, leave, surfaceId, surfaceType]);
}

export function PresenceRail({
  surfaceType,
  surfaceId,
  className,
}: {
  surfaceType: PresenceSurface;
  surfaceId: string;
  className?: string;
}) {
  const viewers = useQuery(api.presence.viewers, { surfaceType, surfaceId });

  return (
    <div className={cn("flex items-center gap-1.5", className)}>
      <AnimatePresence mode="popLayout" initial={false}>
        {(viewers ?? []).map((v) => (
          <motion.div
            key={v.actorId}
            layout
            initial={{ opacity: 0, scale: 0.6, y: 4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.6, y: -4 }}
            transition={SPRING}
            className="relative"
          >
            <span
              // The detail is the agent's own words, which is the difference
              // between "an agent is here" and "an agent is reading the runbook".
              title={
                v.detail
                  ? `${v.name} — ${v.detail}`
                  : `${v.name}${v.editing ? " is writing" : " is here"}`
              }
              aria-label={
                v.detail
                  ? `${v.name}: ${v.detail}`
                  : `${v.name}${v.editing ? " is writing" : " is here"}`
              }
              className={cn(
                "flex h-6 w-6 items-center justify-center rounded-full text-micro font-medium",
                v.actorType === "agent"
                  ? "bg-foreground text-background"
                  : "bg-brand-100 text-brand-700",
              )}
            >
              {initials(v.name)}
            </span>
            {v.editing && (
              <motion.span
                aria-hidden
                // Not a decorative flourish: a pulse is how you tell at a glance
                // that something is happening *now* rather than that someone was
                // here a moment ago.
                className="pointer-events-none absolute -inset-0.5 rounded-full ring-2 ring-foreground/30"
                animate={{ opacity: [0.15, 0.7, 0.15], scale: [1, 1.12, 1] }}
                transition={{ duration: 1.8, repeat: Infinity, ease: EASE }}
              />
            )}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

/**
 * The rail plus a sentence, for surfaces with room for one.
 *
 * The sentence is what makes an agent's presence legible rather than merely
 * visible — "Ada is drafting the migration section" answers the question a
 * pulsing dot only raises.
 */
export function PresenceNote({
  surfaceType,
  surfaceId,
}: {
  surfaceType: PresenceSurface;
  surfaceId: string;
}) {
  const viewers = useQuery(api.presence.viewers, { surfaceType, surfaceId });
  const speaking = (viewers ?? []).find((v) => v.detail) ?? null;
  const writing = (viewers ?? []).find((v) => v.editing) ?? null;
  const subject = speaking ?? writing;

  return (
    <AnimatePresence initial={false}>
      {subject && (
        <motion.p
          key={`${subject.actorId}:${subject.detail ?? subject.editing}`}
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 4 }}
          transition={{ duration: 0.25, ease: EASE }}
          aria-live="polite"
          className="text-xs text-muted-foreground"
        >
          {subject.detail
            ? `${subject.name} — ${subject.detail}`
            : `${subject.name} is writing here`}
        </motion.p>
      )}
    </AnimatePresence>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  const letters = parts.map((p) => p[0]).join("");
  return (letters || "?").toUpperCase();
}

/**
 * A line running the edge of a surface a machine is working inside.
 *
 * Mounted inside any `relative` container. While an agent on this surface is
 * editing, a short stroke travels the perimeter — which says something a
 * pulsing dot cannot: not "an agent is somewhere", but "the machine is working
 * *in this panel*, now". The border it rides doesn't exist otherwise; the
 * surface stays clean when nothing is happening.
 */
export function AgentEdge({
  surfaceType,
  surfaceId,
}: {
  surfaceType: PresenceSurface;
  surfaceId: string;
}) {
  const viewers = useQuery(api.presence.viewers, { surfaceType, surfaceId });
  const active = (viewers ?? []).some(
    (v) => v.actorType === "agent" && v.editing,
  );
  const pathRef = useRef<SVGRectElement | null>(null);

  useEffect(() => {
    if (!active || !pathRef.current) return;
    return traceEdge(pathRef.current);
  }, [active]);

  if (!active) return null;
  return (
    <svg
      aria-hidden
      className="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
    >
      <rect
        ref={pathRef}
        rx="16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        className="text-foreground/50"
        // calc() is CSS, not SVG-attribute syntax: geometry has to come in as
        // style or the rect silently renders at 0x0 and nothing traces.
        style={{
          x: 1,
          y: 1,
          width: "calc(100% - 2px)",
          height: "calc(100% - 2px)",
        }}
      />
    </svg>
  );
}
