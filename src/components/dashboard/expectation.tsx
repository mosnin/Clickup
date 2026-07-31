"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/toast";
import { errorMessage } from "@/lib/errors";
import { timeAgo } from "@/lib/time";
import {
  DIRECTIONS,
  HORIZONS,
  describeExpectation,
  describeOutcome,
  evaluate,
  normalizeExpectation,
  type Direction,
} from "@/lib/calibration";
import { normalizeQuery } from "@/lib/data-stream";
import { PANEL_PRESETS } from "@/lib/panel-intent";
import { normalizePanel } from "@/lib/panel";
import type { PlanNode } from "@/lib/plan";
import { cn } from "@/lib/utils";

// What did you expect to happen?
//
// The plan records what a team decided and nothing about what they expected,
// so nobody ever finds out whether the reasoning was any good. That is the
// difference between an archive and a loop, and closing it is cheap here
// because the claim can be stated in a vocabulary the system already runs:
// "this will cut overdue work" is a panel query and a direction.
//
// **It is offered at the moment of deciding, and only then.** Not because a
// later prompt would be annoying, but because a baseline read afterwards
// already contains the effect — a claim attached next week compares the world
// to itself and can never be wrong. The server refuses to re-baseline, and
// this refuses to offer it once a claim exists.
//
// **The verdict is stated flatly.** A missed claim is the most valuable row in
// the system: the only place a team learns its model of its own work is off.
// Nothing here softens it, colours it as a failure, or attaches it to a
// person's name as a score.

const DIRECTION_WORDS: Record<Direction, string> = {
  down: "go down",
  up: "go up",
  at_most: "stay at or under",
  at_least: "reach at least",
  unchanged: "not move much",
};

export function ExpectationControl({
  decision,
}: {
  // No project needed: the server derives it from the decision and forces the
  // measurement to it, so there is nothing for a caller to get wrong.
  decision: PlanNode & { expectation?: unknown; outcome?: unknown };
}) {
  const attach = useMutation(api.calibration.attach);
  const detach = useMutation(api.calibration.detach);
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [presetId, setPresetId] = useState(PANEL_PRESETS[0]?.id ?? "");
  const [direction, setDirection] = useState<Direction>("down");
  const [target, setTarget] = useState(0);
  const [days, setDays] = useState(HORIZONS[2]?.days ?? 30);

  const stored = normalizeExpectation(decision.expectation);
  const outcome = decision.outcome as
    | { verdict: "met" | "missed" | "unevaluable"; value: number; checkedAt: number }
    | undefined;

  // ── Already claimed ──
  if (stored) {
    const verdict = outcome
      ? { ...outcome, verdict: outcome.verdict }
      : evaluate(stored, null, Date.now());
    return (
      <div className="mt-3 rounded-lg bg-page p-2.5 ring-1 ring-border">
        <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          What was expected
        </span>
        <p className="mt-1 text-[11px] leading-relaxed">
          {describeExpectation(stored)}
          {stored.note ? ` — ${stored.note}` : ""}
        </p>
        <p
          className={cn(
            "mt-1.5 text-[11px] leading-relaxed",
            verdict.verdict === "met" &&
              "rounded bg-[var(--color-pastel-green)] px-1.5 py-0.5",
            verdict.verdict === "missed" &&
              "rounded bg-[var(--color-pastel-red)] px-1.5 py-0.5",
            verdict.verdict !== "met" &&
              verdict.verdict !== "missed" &&
              "text-muted-foreground",
          )}
        >
          {describeOutcome(stored, verdict)}
          {outcome ? ` Checked ${timeAgo(outcome.checkedAt)}.` : ""}
        </p>

        {/* Only before it has been graded. Deleting a checked claim is how a
            team quietly stops being wrong. */}
        {!outcome && (
          <button
            type="button"
            onClick={() =>
              void detach({
                decisionId: decision.id as Id<"planNodes">,
              }).catch((e) =>
                toast(errorMessage(e, "Couldn't withdraw that"), {
                  kind: "error",
                }),
              )
            }
            className="mt-1.5 text-[10px] text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground"
          >
            Withdraw the claim
          </button>
        )}
      </div>
    );
  }

  // ── Not claimed yet ──
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-3 text-[11px] text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground"
      >
        What do you expect this to change?
      </button>
    );
  }

  const preset = PANEL_PRESETS.find((p) => p.id === presetId);
  const query = preset
    ? normalizePanel(preset.def).query
    : normalizeQuery(undefined);
  const needsTarget = direction === "at_most" || direction === "at_least";

  return (
    <div className="mt-3 rounded-lg bg-page p-2.5 ring-1 ring-border">
      <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        What do you expect this to change?
      </span>

      {/* The measure is picked from the same presets the panel builder
          offers, because a claim is a panel question — there is no second
          vocabulary to learn. */}
      <Row label="Watch">
        <select
          aria-label="What to watch"
          value={presetId}
          onChange={(e) => setPresetId(e.currentTarget.value)}
          className="soft-field w-full px-2 py-1 text-[11px]"
        >
          {PANEL_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </Row>

      <Row label="It should">
        <div className="segmented w-full" role="group" aria-label="It should">
          {DIRECTIONS.map((d) => (
            <button
              key={d}
              type="button"
              aria-pressed={d === direction}
              onClick={() => setDirection(d)}
              className={cn(
                "min-w-0 flex-1 whitespace-nowrap px-1.5 py-1 text-[10px]",
                d === direction && "segmented-on",
              )}
            >
              {DIRECTION_WORDS[d]}
            </button>
          ))}
        </div>
      </Row>

      {needsTarget && (
        <Row label="Number">
          <input
            type="range"
            min={0}
            max={50}
            value={target}
            aria-label="Number"
            onChange={(e) => setTarget(Number(e.currentTarget.value))}
            className="w-full accent-foreground"
          />
          <span className="text-[10px] tabular-nums text-muted-foreground">
            {target}
          </span>
        </Row>
      )}

      <Row label="By">
        <div className="segmented w-full" role="group" aria-label="By">
          {HORIZONS.map((h) => (
            <button
              key={h.days}
              type="button"
              aria-pressed={h.days === days}
              onClick={() => setDays(h.days)}
              className={cn(
                "min-w-0 flex-1 whitespace-nowrap px-1.5 py-1 text-[10px]",
                h.days === days && "segmented-on",
              )}
            >
              {h.label}
            </button>
          ))}
        </div>
      </Row>

      <div className="mt-2.5 flex gap-1.5">
        <Button
          size="sm"
          className="flex-1"
          onClick={() => {
            void attach({
              decisionId: decision.id as Id<"planNodes">,
              query,
              direction,
              target: needsTarget ? target : undefined,
              dueAt: Date.now() + days * 86_400_000,
            })
              .then(() => {
                setOpen(false);
                toast("Claim recorded. It'll be checked automatically.");
              })
              .catch((e) =>
                toast(errorMessage(e, "Couldn't record that"), {
                  kind: "error",
                }),
              );
          }}
        >
          Record it
        </Button>
        <Button size="sm" variant="outline" onClick={() => setOpen(false)}>
          Skip
        </Button>
      </div>

      <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
        The number is read now and compared later. That is why it can only be
        set here — a baseline taken afterwards already contains the effect.
      </p>
    </div>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-2">
      <span className="block text-[10px] text-muted-foreground">{label}</span>
      <div className="mt-1 flex items-center gap-2">{children}</div>
    </div>
  );
}

/** The scope's track record — how often its claims turn out to be right. */
export function CalibrationSummary({
  scopeType,
  scopeId,
}: {
  scopeType: "user" | "workspace";
  scopeId: string;
}) {
  const rows = useQuery(api.calibration.forScope, { scopeType, scopeId });
  if (rows === undefined || rows.length === 0) return null;

  const outcomes = rows.map((r) => ({
    verdict: (r.outcome?.verdict ?? "pending") as
      | "met"
      | "missed"
      | "pending"
      | "unevaluable",
  }));
  const met = outcomes.filter((o) => o.verdict === "met").length;
  const missed = outcomes.filter((o) => o.verdict === "missed").length;
  const graded = met + missed;

  return (
    <p className="text-[11px] leading-relaxed text-muted-foreground">
      {graded === 0
        ? `${outcomes.length} claim${outcomes.length === 1 ? "" : "s"} waiting to be checked.`
        : `${met} of ${graded} claims held (${Math.round((met / graded) * 100)}%).`}
    </p>
  );
}
