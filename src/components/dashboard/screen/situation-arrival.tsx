"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { AnimatePresence, motion } from "motion/react";
import type { Id } from "@convex/_generated/dataModel";
import { api } from "@convex/_generated/api";
import { EASE } from "@/components/motion";
import { useToast } from "@/components/toast";
import { errorMessage } from "@/lib/errors";
import type { ScreenLayout } from "@/lib/screen-layout";
import {
  nextAnnouncement,
  nextDeparture,
  type SituationState,
} from "@/lib/situation";

// A panel that is true rather than placed, arriving on somebody's screen.
//
// The whole difficulty of this feature is in one sentence: the screen has
// something to say and no right to act. `convex/situations.ts` decides whether
// a condition holds; `src/lib/situation.ts` decides whether that is worth
// interrupting somebody about; this decides nothing at all — it says the thing
// and carries out whichever answer it gets.
//
// The consent shape is deliberately, literally, the screen-proposal banner's:
// **Preview / Not now / Keep**, in that reading order, over a sentence that
// names the CONDITION rather than the panel. Not because a second idiom would
// be hard to build, but because a second idiom is how "the interface never
// changes without you" stops being a property of the product and becomes a
// property of one screen. Somebody who has answered an agent's proposal once
// already knows what these three words do.
//
// Three things it is careful about:
//
// **Preview morphs the real grid.** The panel goes into the canvas, at the size
// and in the slot it would really occupy, drawing this scope's real data. A
// suggested panel is exactly as good as what it turns out to say about your own
// work, and a mockup cannot tell you that. Editing while previewing is refused,
// the same rule screen proposals have, because an edit made against a layout
// you have not accepted would silently save it as yours.
//
// **"Not now" is durable.** It is recorded against the occurrence, so the
// banner does not come back on the next sweep — and it is not permanent, so the
// same condition arising again after it has cleared is offered again. See
// `shouldAnnounce`.
//
// **Nothing leaves by itself.** A kept panel is in the reader's layout and
// stays there; when its condition stops holding they are told, once, and given
// a one-tap way to remove it. A panel that was only being previewed withdraws,
// because it was never theirs.

type ForScreenRow = {
  subscriptionId: string;
  panelId: string;
  description: string;
  isTrue: boolean;
  becameTrueAt: number | null;
  becameFalseAt: number | null;
  acknowledgedAt: number | null;
  resolution: "kept" | "dismissed" | null;
};

export function useScreenSituations({
  screenKey,
  layout,
  available,
  enabled = true,
  onPlace,
  onRemove,
}: {
  screenKey: string;
  /** The reader's OWN saved layout — never one being previewed. */
  layout: ScreenLayout;
  /** Widget ids this screen can actually draw. */
  available: readonly string[];
  /**
   * False while the surface is showing an arrangement that is not the reader's
   * own — an agent's proposal being previewed, say.
   *
   * Not a feature flag and not a per-surface difference: it is the one fact
   * about a layout that only the surface holding it can know. Offering a panel
   * against somebody else's arrangement would place it into that arrangement,
   * and a surface that refuses edits while previewing (which is the rule) would
   * refuse it — leaving the reader having answered a question whose answer went
   * nowhere. Silence is the honest state.
   */
  enabled?: boolean;
  /** Put the panel on the screen. The server does not know your layout. */
  onPlace: (panelId: string) => void;
  /** Take it off again, at the reader's request and never otherwise. */
  onRemove: (panelId: string) => void;
}): { previewPanelId: string | null; banner: React.ReactNode } {
  const rows = useQuery(api.situations.forScreen, { screenKey }) as
    | ForScreenRow[]
    | undefined;
  const acknowledge = useMutation(api.situations.acknowledge);
  const { toast } = useToast();

  /** Which subscription is being previewed. Local: a preview is not a change. */
  const [previewing, setPreviewing] = useState<string | null>(null);
  /**
   * A preview whose condition stopped holding while it was on the canvas.
   *
   * Local and unrecorded on purpose — this preview only ever existed in this
   * tab, so the fact that it went away is only true here. Persisting it would
   * make a second tab report a withdrawal it never showed.
   */
  const [withdrawn, setWithdrawn] = useState<string | null>(null);

  const states = useMemo<SituationState[]>(
    () =>
      (rows ?? []).map((r) => ({
        subscriptionId: r.subscriptionId,
        panelId: r.panelId,
        description: r.description,
        isTrue: r.isTrue,
        becameTrueAt: r.becameTrueAt,
        becameFalseAt: r.becameFalseAt,
        acknowledgedAt: r.acknowledgedAt,
        resolution: r.resolution,
      })),
    [rows],
  );

  const placed = useMemo(
    () => new Set(layout.widgets.map((w) => w.id)),
    [layout.widgets],
  );
  const factsFor = useCallback(
    (s: SituationState) => ({
      onScreen: placed.has(s.panelId),
      drawable: available.includes(s.panelId),
    }),
    [available, placed],
  );

  const arrival = enabled ? nextAnnouncement(states, factsFor) : null;
  const departure = enabled ? nextDeparture(states, factsFor) : null;

  // ── The preview withdrawing ──
  //
  // A preview is only honest while the thing it is previewing is still on
  // offer. The moment the condition stops holding, the panel on the canvas is
  // there for a reason that is no longer true — so it steps back (the tiles'
  // own CSS transition closes the gap as one movement rather than snapping)
  // and says why. Nothing is written: nothing ever was.
  const live = arrival !== null && arrival.subscriptionId === previewing;
  const previewedState =
    states.find((s) => s.subscriptionId === previewing) ?? null;
  // The note is for a condition that LAPSED. A subscription that is gone
  // altogether was cancelled by the reader — from the "Only here sometimes"
  // list in the arrange tray, which is the other half of this feature — and
  // telling somebody their own action happened is noise. The panel steps back
  // either way; only the sentence is conditional.
  const previewedDescription = previewedState?.description ?? null;
  useEffect(() => {
    if (previewing === null || live) return;
    setPreviewing(null);
    setWithdrawn(previewedDescription);
  }, [live, previewedDescription, previewing]);

  // Read inside the callbacks below without making them depend on it, so a
  // toast handler built one render ago still answers about the current state.
  const arrivalRef = useRef(arrival);
  arrivalRef.current = arrival;

  const answer = useCallback(
    (s: SituationState, resolution: "kept" | "dismissed") => {
      // Placed only once the answer is recorded. The other order puts a panel
      // on somebody's screen and then discovers it could not remember being
      // told to — at which point the banner is gone and the panel is
      // unexplained.
      void acknowledge({
        subscriptionId: s.subscriptionId as Id<"panelSituations">,
        resolution,
      })
        .then(() => {
          if (resolution === "kept") onPlace(s.panelId);
          // Cleared in the same tick as the placement, so React renders one
          // frame in which the panel is real and the preview is off — rather
          // than a frame with neither, which reads as the panel flickering out
          // and back at the moment of accepting it.
          setPreviewing(null);
          setWithdrawn(null);
        })
        .catch((e) =>
          toast(errorMessage(e, "Couldn't answer that"), { kind: "error" }),
        );
    },
    [acknowledge, onPlace, toast],
  );

  const acknowledgeDeparture = useCallback(
    (s: SituationState, remove: boolean) => {
      if (remove) onRemove(s.panelId);
      void acknowledge({
        subscriptionId: s.subscriptionId as Id<"panelSituations">,
      }).catch((e) =>
        toast(errorMessage(e, "Couldn't answer that"), { kind: "error" }),
      );
    },
    [acknowledge, onRemove, toast],
  );

  const banner = (
    <AnimatePresence initial={false}>
      {arrival ? (
        <Announcement
          key={`arrival:${arrival.subscriptionId}:${arrival.becameTrueAt}`}
          description={arrival.description}
          previewing={live}
          onPreview={() =>
            setPreviewing(live ? null : arrival.subscriptionId)
          }
          onDismiss={() => answer(arrival, "dismissed")}
          onKeep={() => {
            if (live) answer(arrival, "kept");
            else answer(arrival, "kept");
          }}
        />
      ) : departure ? (
        <Departure
          key={`departure:${departure.subscriptionId}:${departure.becameFalseAt}`}
          description={departure.description}
          onKeep={() => acknowledgeDeparture(departure, false)}
          onRemove={() => acknowledgeDeparture(departure, true)}
        />
      ) : withdrawn ? (
        <Withdrawn
          key="withdrawn"
          description={withdrawn}
          onClose={() => setWithdrawn(null)}
        />
      ) : null}
    </AnimatePresence>
  );

  return { previewPanelId: live && arrival ? arrival.panelId : null, banner };
}

/** The shared skin, so three notices cannot drift into three designs. */
function Notice({
  children,
  actions,
}: {
  children: React.ReactNode;
  actions: React.ReactNode;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.3, ease: EASE }}
      className="bento-tile flex flex-wrap items-center gap-3 rounded-2xl p-4"
    >
      {/* `min-w-0` here would be a lie about what this sentence needs.
          `flex-wrap` only wraps when an item cannot shrink any further, so a
          text block that will shrink to nothing never wraps — it just gets
          narrower and narrower beside the buttons, and at 390px the condition
          came out as a five-word-tall column two words wide, which is how the
          harness found it. A real floor is what makes the actions drop to
          their own line instead. */}
      <div className="min-w-[14rem] flex-1">{children}</div>
      <div className="flex flex-wrap items-center gap-2">{actions}</div>
    </motion.div>
  );
}

function QuietButton({
  children,
  onClick,
  pressed,
}: {
  children: React.ReactNode;
  onClick: () => void;
  pressed?: boolean;
}) {
  return (
    <button
      type="button"
      {...(pressed === undefined ? {} : { "aria-pressed": pressed })}
      onClick={onClick}
      className="rounded-full px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
    >
      {children}
    </button>
  );
}

function SolidButton({
  children,
  onClick,
}: {
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-full bg-foreground px-3 py-1.5 text-xs text-background"
    >
      {children}
    </button>
  );
}

/**
 * The arrival.
 *
 * The sentence is the condition and nothing else — "Open tasks in this sprint
 * reached 6", computed by `describeSituation` from the definition. Naming the
 * panel instead ("Sprint panel is available") answers a question nobody asked:
 * what a reader needs to know is what changed in their work, and the panel is
 * merely the offer that follows from it.
 */
function Announcement({
  description,
  previewing,
  onPreview,
  onDismiss,
  onKeep,
}: {
  description: string;
  previewing: boolean;
  onPreview: () => void;
  onDismiss: () => void;
  onKeep: () => void;
}) {
  return (
    <Notice
      actions={
        <>
          <QuietButton pressed={previewing} onClick={onPreview}>
            {previewing ? "Show mine" : "Preview"}
          </QuietButton>
          <QuietButton onClick={onDismiss}>Not now</QuietButton>
          <SolidButton onClick={onKeep}>Keep</SolidButton>
        </>
      }
    >
      <p className="text-sm">
        {description}
        <span className="text-muted-foreground">
          {" "}
          — there&apos;s a panel for that
        </span>
      </p>
      <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
        Preview puts it on this screen so you can see what it says about your
        work. Keep it and it&apos;s yours until you remove it.
      </p>
    </Notice>
  );
}

/**
 * The departure of a panel the reader kept.
 *
 * Stated flatly and without an apology, because the panel is not going
 * anywhere: the reader placed it, so it is an ordinary part of their screen
 * now. This exists only so nobody is left reading a panel whose premise has
 * quietly expired — the missing-claim rule from calibration, one surface along.
 */
function Departure({
  description,
  onKeep,
  onRemove,
}: {
  description: string;
  onKeep: () => void;
  onRemove: () => void;
}) {
  return (
    <Notice
      actions={
        <>
          <QuietButton onClick={onRemove}>Remove it</QuietButton>
          <SolidButton onClick={onKeep}>Keep it</SolidButton>
        </>
      }
    >
      <p className="text-sm">
        {description}
        <span className="text-muted-foreground"> — not any more</span>
      </p>
      <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
        The panel stays on your screen; it&apos;s yours. Remove it here if it
        has done its job.
      </p>
    </Notice>
  );
}

/** A preview that stepped back, because the thing it previewed stopped being true. */
function Withdrawn({
  description,
  onClose,
}: {
  description: string;
  onClose: () => void;
}) {
  return (
    <Notice actions={<QuietButton onClick={onClose}>Dismiss</QuietButton>}>
      <p className="text-sm text-muted-foreground">
        {description} — not any more, so the preview stepped back. Nothing was
        saved.
      </p>
    </Notice>
  );
}
