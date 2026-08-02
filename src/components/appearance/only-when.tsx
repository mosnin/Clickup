"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
// The refusal matrix lives beside the resolver it describes — see the header of
// `convex/_situations.ts`. Importing it rather than restating it is the whole
// point: this file's job is to never offer a condition the mutation would
// refuse, and a second copy of the rule is how the composer and the server
// start disagreeing about which ones those are. The module is pure (it imports
// nothing), so the Next tree can hold it.
import { situationRefusal } from "@convex/_situations";
import { useToast } from "@/components/toast";
import { errorMessage } from "@/lib/errors";
import { normalizePanel, panelIdFromWidgetId, type PanelDef } from "@/lib/panel";
import { useMintableBuiltIn } from "@/components/appearance/mintable-panels";
import {
  COMPARISONS,
  comparisonLabel,
  describeAnswer,
  describeSituation,
  isSituationTrue,
  normalizeSituation,
  SITUATION_STARTERS,
  type Comparison,
  type Situation,
} from "@/lib/situation";
import { describeQuery, type DataQuery } from "@/lib/data-stream";
import { cn } from "@/lib/utils";

// Saying when a panel should be here.
//
// A dashboard is a shelf: things go on it and they stay, and the only lever
// anybody has is "on the screen" or "not on the screen". The alternative every
// other product reaches for is an alerts system — a separate place to configure
// conditions and a separate place they arrive in, neither of which is the panel
// that would have explained it. A situation is the third option, and this is
// where a person states one: on the panel, while looking at the number it is
// about.
//
// Four things this surface is careful about.
//
// **One question at a time.** Which question, then when. Not four fields
// stacked into a form with a Save at the bottom — the card builder answered
// this shape already (`card-builder.tsx`) and this follows it: a shelf of
// finished starting points, then one row of full-size options on the centre
// axis.
//
// **The options are drawn, and the number is measured.** "at least / at most /
// exactly" are three words that say almost nothing; three gauges showing which
// side of a line is true say it instantly. And the threshold is set against the
// LIVE reading of the same question — through `dataStream.resolve`, the
// resolver the panel itself runs, never a second evaluator — so the person
// picks "6" while looking at "it's 4 right now", instead of guessing at a
// number in the abstract.
//
// **It reads back in the sentence the rest of the system uses.**
// `describeSituation` and nothing else, so the studio, the event log and
// anything that announces an arrival say the same words about one condition.
//
// **The composer cannot author a refusal.** `situations.subscribe` refuses
// rather than repairs — a malformed condition would make panels appear for
// reasons that are not true — so the confirm affordance is disabled, with the
// reason on screen, whenever `normalizeSituation` or `situationRefusal` would
// turn this draft away.

export type StudioScope = { scopeType: "user" | "workspace"; scopeId: string };

// ── The panel the studio is pointed at ──────────────────────────────────

export type StudioPanel = {
  /** The definition, stored or (for a built-in) the question it asks. */
  def: PanelDef;
  /** Where it reads from, and where anything minted from it would live. */
  scope: StudioScope;
  /** The stored row, absent for a built-in. */
  row: { componentId: Id<"uiComponents">; definition: unknown } | null;
};

/**
 * What is under the studio right now, whichever kind of panel it is.
 *
 * Two things arrive here and they are not the same object: a panel with a
 * stored definition, and a built-in whose body is code. Both can be asked
 * "what question do you ask", which is all a situation needs, so both answer
 * here and the callers stop caring which they got.
 */
export function useStudioPanel(selectionId: string | null): StudioPanel | null {
  const componentId = useMemo(() => {
    if (!selectionId) return null;
    const tail = selectionId.slice(selectionId.indexOf(":") + 1);
    return panelIdFromWidgetId(tail);
  }, [selectionId]);

  const row = useQuery(
    api.uiComponents.get,
    componentId ? { componentId } : "skip",
  );
  // Null for a selection that already has a definition — a stored panel's
  // widget id is `custom:<id>`, which no built-in registry answers for.
  const mintable = useMintableBuiltIn(selectionId);

  const stored = useMemo<PanelDef | null>(
    () => (row ? normalizePanel(row.definition) : null),
    [row],
  );

  if (stored && row) {
    return {
      def: stored,
      scope: { scopeType: row.scopeType, scopeId: row.scopeId },
      row: { componentId: row.componentId, definition: row.definition },
    };
  }
  if (mintable) {
    return { def: mintable.question, scope: mintable.scope, row: null };
  }
  return null;
}

// ── Measuring, through the resolver the panel runs ───────────────────────

/**
 * What this question answers right now, or null while it is unreadable.
 *
 * Null is emphatically not zero: zero satisfies `at_most` forever, and a
 * reading that fell through as a number would tell somebody their condition
 * was true at precisely the moment nothing could be measured. The same
 * distinction `convex/situations.ts measure()` makes, for the same reason.
 */
export function useMeasured(
  scope: StudioScope | null,
  query: DataQuery | null,
): number | null {
  // The reader's own day boundaries — Convex runs in UTC and "overdue" is a
  // question about their today.
  const tzOffsetMinutes = useMemo(() => -new Date().getTimezoneOffset(), []);
  // Held by value: an object literal rebuilt every render re-subscribes every
  // render, and this query walks a scope's lists.
  const key = query ? JSON.stringify(query) : "";
  const stable = useMemo<DataQuery | null>(
    () => (key ? (JSON.parse(key) as DataQuery) : null),
    [key],
  );

  const envelope = useQuery(
    api.dataStream.resolve,
    scope && stable
      ? { ...scope, query: stable, tzOffsetMinutes }
      : "skip",
  );
  if (envelope === undefined) return null;
  return Number.isFinite(envelope.scalar) ? envelope.scalar : null;
}

// ── Step one's cards: a question, with its own answer on it ──────────────

/**
 * A candidate question, drawn as the number it currently produces.
 *
 * The reason this is a live reading rather than a description: a condition is
 * only worth subscribing to if its subject is doing something, and "Blocked
 * tasks — 0" answers that in one glance where a sentence cannot. It is the
 * same argument the builder's shelves make by rendering real panels.
 */
export function QuestionCard({
  label,
  query,
  scope,
}: {
  label: string;
  query: DataQuery;
  scope: StudioScope | null;
}) {
  const value = useMeasured(scope, query);
  return (
    // Sized like the other chapters' specimens rather than to its content: a
    // shelf whose cards are half the height of every other shelf's reads as an
    // unfinished chapter, and the sheet has the room.
    <span className="bento flex h-[13rem] flex-col rounded-3xl bg-card p-5 text-left sm:h-[15rem] sm:p-6">
      <span className="block text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        Right now
      </span>
      <span className="flex flex-1 items-center text-5xl font-semibold tabular-nums sm:text-6xl">
        {value === null ? "—" : formatValue(value)}
      </span>
      <span className="block text-sm font-medium leading-snug">{label}</span>
      {/* The question itself, in the sentence the whole product reads a query
          back in. A condition you cannot audit is one you should not trust to
          decide what is on your screen. */}
      <span className="mt-0.5 line-clamp-2 block text-[11px] leading-relaxed text-muted-foreground">
        {describeQuery(query)}
      </span>
    </span>
  );
}

/** Counts stay whole; a rate or an hours total keeps one decimal. */
function formatValue(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

// ── Step two: when ───────────────────────────────────────────────────────

/**
 * The comparison, drawn as what it does to the panel.
 *
 * A track with the threshold at its middle, the side that makes the condition
 * true filled in, and a dot where the value actually is. Reading it takes no
 * words: you can see whether today's number falls in the shaded part.
 */
function ComparisonGauge({
  compare,
  value,
  threshold,
  on,
}: {
  compare: Comparison;
  value: number | null;
  threshold: number;
  on: boolean;
}) {
  // The threshold sits at the middle of the track and everything else is
  // placed relative to it, so the drawing means the same thing at a threshold
  // of 3 and at a threshold of 300.
  const span = Math.max(Math.abs(threshold), 1) * 2;
  const at =
    value === null ? null : Math.min(0.96, Math.max(0.04, value / span));

  return (
    <span aria-hidden className="relative mt-2 block h-6">
      <span className="absolute inset-x-0 top-2.5 block h-1.5 rounded-full bg-foreground/12" />
      {/* The true side, and it has to be legible on the options NOT chosen —
          the whole reason these are drawn rather than named is that you can
          compare them at a glance, which a fill you can only see once you have
          already picked it cannot do. */}
      <span
        className={cn(
          "absolute top-2.5 block h-1.5",
          on ? "bg-foreground" : "bg-foreground/55",
          compare === "at_least" && "left-1/2 right-0 rounded-r-full",
          compare === "at_most" && "left-0 right-1/2 rounded-l-full",
          compare === "equals" && "left-[44%] right-[44%] rounded-full",
        )}
      />
      {/* The line the number has to cross. */}
      <span
        className={cn(
          "absolute left-1/2 top-0.5 block h-5 w-0.5 -translate-x-1/2 rounded-full",
          on ? "bg-foreground" : "bg-foreground/45",
        )}
      />
      {at !== null && (
        <span
          className="absolute top-1.5 block h-3 w-3 -translate-x-1/2 rounded-full bg-card ring-2 ring-foreground"
          style={{ left: `${at * 100}%` }}
        />
      )}
    </span>
  );
}

/**
 * The one row of full-size options, then the number, then the sentence.
 *
 * Deliberately not a shelf: three comparisons drawn as gauges fit on one line
 * at 390px, and a carousel you have to swipe through to see all three of
 * anything is a control that hides two thirds of itself.
 */
export function WhenStep({
  label,
  query,
  scope,
  compare,
  threshold,
  onCompare,
  onThreshold,
  onMeasured,
}: {
  label: string;
  query: DataQuery;
  scope: StudioScope | null;
  compare: Comparison;
  threshold: number;
  onCompare: (compare: Comparison) => void;
  onThreshold: (threshold: number) => void;
  /** The live reading, reported up so the threshold can be seeded from it. */
  onMeasured?: (value: number | null) => void;
}) {
  const value = useMeasured(scope, query);
  const report = useRef(onMeasured);
  report.current = onMeasured;
  useEffect(() => {
    report.current?.(value);
  }, [value]);
  const draft: Situation = { id: "draft", label, query, compare, threshold };

  return (
    <div className="px-4 text-left">
      <div className="flex items-stretch gap-2">
        {COMPARISONS.map((c) => (
          <button
            aria-pressed={c === compare}
            className={cn(
              "min-w-0 flex-1 rounded-2xl px-2 py-4 text-center transition-colors",
              c === compare
                ? "bg-card ring-2 ring-foreground"
                : "bg-card/60 ring-1 ring-border hover:ring-muted-foreground/40",
            )}
            key={c}
            onClick={() => onCompare(c)}
            type="button"
          >
            <span className="block truncate text-[12px] font-medium">
              {comparisonLabel(c)}
            </span>
            <ComparisonGauge
              compare={c}
              on={c === compare}
              threshold={threshold}
              value={value}
            />
          </button>
        ))}
      </div>

      {/* The number, as two 44px targets and a digit — a thumb changes it
          without a keyboard ever opening. */}
      <div className="mt-5 flex items-center justify-center gap-4">
        <StepButton
          label="One fewer"
          onClick={() => onThreshold(Math.max(0, threshold - 1))}
        >
          −
        </StepButton>
        <span
          aria-live="polite"
          className="min-w-[3ch] text-center text-4xl font-semibold tabular-nums"
        >
          {threshold}
        </span>
        <StepButton label="One more" onClick={() => onThreshold(threshold + 1)}>
          +
        </StepButton>
      </div>

      {/* Against the live reading, which is the whole reason a threshold can be
          chosen rather than guessed at. */}
      <p className="mt-3 text-center text-[12px] leading-relaxed text-muted-foreground">
        {value === null ? (
          "Measuring…"
        ) : (
          <>
            Right now it&apos;s{" "}
            <span className="font-medium text-foreground tabular-nums">
              {formatValue(value)}
            </span>{" "}
            —{" "}
            {isSituationTrue(draft, value, false)
              ? "this is true, so it would be here."
              : /* "not true NOW", never "not yet" — `at most` becomes true by
                   the number going down, and "yet" quietly promises the wrong
                   direction on a third of these. */
                "not true now, so it would stay away."}
          </>
        )}
      </p>
    </div>
  );
}

function StepButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      aria-label={label}
      className="flex h-11 w-11 items-center justify-center rounded-full bg-card text-lg ring-1 ring-border transition-colors hover:bg-accent"
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}

// ── Committing, and taking it back ──────────────────────────────────────

/**
 * Why this draft cannot be subscribed, or null.
 *
 * Both halves of the server's refusal, run here first: the shape
 * (`normalizeSituation`, which refuses rather than repairs) and the semantics
 * (`situationRefusal`, which knows filter by filter what the resolver actually
 * honours for a source). A confirm button that produces a red toast is a
 * control that looked available and was not.
 */
export function situationProblem(
  situation: Situation,
  scopeType: "user" | "workspace",
): string | null {
  if (!normalizeSituation(situation)) {
    return "This condition is missing something it needs.";
  }
  if (!Number.isFinite(situation.threshold) || situation.threshold < 0) {
    return "Pick a number this can be compared against.";
  }
  return situationRefusal(situation.query, scopeType);
}

/** Subscribe / unsubscribe, with the undo window the feedback system asks for. */
export function useSituationCommit(screenKey: string | null) {
  const subscribe = useMutation(api.situations.subscribe);
  const unsubscribe = useMutation(api.situations.unsubscribe);
  const { toast } = useToast();
  /** Rows hidden while their undo window is open — deleted only when it closes. */
  const [clearing, setClearing] = useState<Id<"panelSituations">[]>([]);

  return {
    clearing,
    save: (
      scope: StudioScope,
      panelId: string,
      situation: Situation,
      onDone?: () => void,
    ) => {
      if (!screenKey) return;
      void subscribe({ ...scope, screenKey, panelId, situation })
        .then(() => {
          // The sentence verbatim, for the reason the studio shows it verbatim.
          toast(`Only here when: ${describeSituation(situation)}`);
          onDone?.();
        })
        .catch((e) =>
          toast(errorMessage(e, "Couldn't set that condition"), {
            kind: "error",
          }),
        );
    },
    clear: (subscriptionId: Id<"panelSituations">, description: string) => {
      // Hidden first, deleted when the undo window closes — the destructive
      // half never runs while it can still be taken back, which is what lets
      // this be one tap with no dialog in front of it.
      setClearing((ids) => [...ids, subscriptionId]);
      toast(`Back to always — was "${description}"`, {
        action: {
          label: "Undo",
          onClick: () =>
            setClearing((ids) => ids.filter((i) => i !== subscriptionId)),
        },
        onExpire: () => {
          void unsubscribe({ subscriptionId }).catch((e) =>
            toast(errorMessage(e, "Couldn't clear that"), { kind: "error" }),
          );
        },
      });
    },
  };
}

// ── What is already set ─────────────────────────────────────────────────

type SubscriptionRow = {
  subscriptionId: Id<"panelSituations">;
  panelId: string;
  description: string;
  isTrue: boolean;
  value: number | null;
  // What happened the last time this became true. The banner above the canvas
  // and this list read the same query, so a condition answered there has to
  // read as answered here — otherwise the list says "True now" about something
  // that is visibly not happening, and the feature reads as broken.
  becameTrueAt: number | null;
  acknowledgedAt: number | null;
  resolution: "kept" | "dismissed" | null;
};

/**
 * Every condition on this screen, with a way out of each.
 *
 * This is not decoration, it is what makes the feature reversible. A panel that
 * only appears sometimes is invisible exactly when it is not appearing, so a
 * subscription is the one setting in this product that cannot be found by
 * pointing at the thing it governs. It therefore has two homes and needs both:
 * the studio's own chapter answers it for the panel you are standing on, and
 * this list answers it for the screen — rendered in the arrange tray, beside
 * the panels that are not placed, because "here is what is not on your screen
 * and why" is one question.
 */
export function OnlyWhenList({ screenKey }: { screenKey: string }) {
  const rows = useQuery(api.situations.forScreen, { screenKey }) as
    | SubscriptionRow[]
    | undefined;
  const { clearing, clear } = useSituationCommit(screenKey);
  const visible = (rows ?? []).filter(
    (r) => !clearing.includes(r.subscriptionId),
  );
  if (visible.length === 0) return null;

  return (
    <section className="mt-4 border-t border-border/60 pt-4">
      <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        Only here sometimes
      </span>
      <ul className="mt-3 space-y-2">
        {visible.map((row) => {
          // Why nothing is announcing, computed from the same row the banner
          // reads so the two can never disagree.
          const answered = describeAnswer({
            ...row,
            subscriptionId: row.subscriptionId as string,
            becameFalseAt: null,
          });
          return (
          <li
            className="bento-tile flex flex-wrap items-center gap-2 rounded-2xl p-3"
            key={row.subscriptionId}
          >
            <span className="min-w-0 flex-1">
              <span className="block text-sm">{row.description}</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                {row.isTrue ? "True now" : "Not true now"}
                {row.value === null ? "" : ` · measured ${formatValue(row.value)}`}
                {answered === null ? "" : ` · ${answered}`}
              </span>
            </span>
            <button
              className="tap-target shrink-0 rounded-full px-3 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => clear(row.subscriptionId, row.description)}
              type="button"
            >
              Always show
            </button>
          </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * The condition on ONE panel, if it has one.
 *
 * Returned as data rather than as a component so the studio chapter can decide
 * whether it is showing a composer or a state — a chapter that renders both at
 * once is the stacked form this whole surface exists not to be.
 */
export function usePanelSituation(
  screenKey: string | null,
  panelId: string | null,
): SubscriptionRow | null {
  const rows = useQuery(
    api.situations.forScreen,
    screenKey ? { screenKey } : "skip",
  ) as SubscriptionRow[] | undefined;
  if (!rows || !panelId) return null;
  return rows.find((r) => r.panelId === panelId) ?? null;
}

// ── The draft ───────────────────────────────────────────────────────────

/**
 * The questions offered for this panel, its own first.
 *
 * Its own first because that is nearly always the answer: somebody subscribing
 * a panel about overdue work means "when overdue work reaches N", and making
 * them re-state the question the panel is already asking is a form asking for
 * something it can see. The rest are there because a panel's own question is
 * sometimes not the trigger for it — a sprint board is worth showing when
 * something is BLOCKED, not when the sprint has tasks in it.
 */
export function questionsFor(
  panel: StudioPanel | null,
): { id: string; label: string; query: DataQuery }[] {
  const own =
    panel && situationRefusal(panel.def.query, panel.scope.scopeType) === null
      ? [
          {
            id: "panel",
            label: panel.def.title,
            query: panel.def.query,
          },
        ]
      : [];
  return [...own, ...SITUATION_STARTERS];
}
