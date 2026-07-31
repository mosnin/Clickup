"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { AnimatePresence, motion } from "motion/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { InlineCreate } from "@/components/dashboard/inline-create";
import { ActorGlyph } from "@/components/appearance/actor-glyph";
import { EASE, Reveal, Stagger, StaggerItem } from "@/components/motion";
import { useToast } from "@/components/toast";
import { errorMessage } from "@/lib/errors";
import { timeAgo } from "@/lib/time";
import {
  describePlan,
  planView,
  stateLabel,
  type OptionView,
  type QuestionState,
  type QuestionView,
} from "@/lib/plan";
import { cn } from "@/lib/utils";

// The plan, as a place.
//
// The layout is the argument. A deliberation reads left to right — question,
// then the answers anyone offered, then what we actually know about each — and
// the screen says exactly that, which is why it can be understood without
// being read. A transcript can't be understood without being read; that is the
// whole complaint against it.
//
// Two decisions carry most of the value:
//
// **Settled questions collapse to one line.** A plan's job is to make the
// current state small, and ninety per cent of a mature plan is settled. One
// line each — the question, the answer, who signed it — with the working one
// click away. Anything else and the thing you need is buried in the thing you
// already agreed.
//
// **Every status here is computed** (`planView`), so nothing on this screen
// can be stale. "Ready to decide" is not a flag somebody set; it is what "every
// option has been argued and nothing chosen" *means*. That is why the ordering
// is trustworthy enough to act on top-down.

const STATE_CHIP: Record<QuestionState, string> = {
  awaiting: "bg-[var(--color-pastel-yellow)] text-foreground",
  ready: "bg-[var(--color-pastel-blue)] text-foreground",
  weighing: "bg-muted text-muted-foreground",
  unexplored: "bg-muted text-muted-foreground",
  decided: "bg-[var(--color-pastel-green)] text-foreground",
};

export function PlanCanvas({ projectId }: { projectId: string }) {
  const rows = useQuery(api.plans.forProject, {
    projectId: projectId as Id<"projects">,
  });
  const ask = useMutation(api.plans.ask);
  const { toast } = useToast();
  const [asking, setAsking] = useState(false);
  const [needsHuman, setNeedsHuman] = useState(false);

  const view = useMemo(() => planView(rows ?? []), [rows]);

  if (rows === undefined) return <PlanSkeleton />;

  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-lg font-semibold">The thinking</h2>
        <p className="title-rule mt-1 pb-2 text-sm text-muted-foreground">
          {describePlan(view)}
        </p>
      </header>

      {asking ? (
        <div className="bento rounded-2xl p-4">
          <InlineCreate
            placeholder="What haven't we decided?"
            onSubmit={async (body) => {
              await ask({
                projectId: projectId as Id<"projects">,
                body,
                needsHuman,
              })
                .then(() => {
                  setAsking(false);
                  setNeedsHuman(false);
                })
                .catch((e) =>
                  toast(errorMessage(e, "Couldn't raise that"), {
                    kind: "error",
                  }),
                );
            }}
            onCancel={() => setAsking(false)}
          />
          {/* Raising the gate at the moment of asking, because that is when
              you know whether this is yours to call. */}
          <button
            type="button"
            aria-pressed={needsHuman}
            onClick={() => setNeedsHuman((v) => !v)}
            className={cn(
              "mt-2 rounded-full px-3 py-1 text-[11px] transition-colors",
              needsHuman
                ? "bg-foreground text-background"
                : "bento-tile text-muted-foreground hover:text-foreground",
            )}
          >
            A person has to settle this one
          </button>
        </div>
      ) : (
        <Button variant="outline" size="sm" onClick={() => setAsking(true)}>
          Raise a question
        </Button>
      )}

      {view.questions.length === 0 && !asking && (
        <p className="text-sm leading-relaxed text-muted-foreground">
          Nothing has been raised yet. Questions asked here are readable by
          everyone working on this project — including the agents, which is the
          point: a decision written down once is a decision nobody re-litigates.
        </p>
      )}

      <Stagger className="space-y-4">
        {view.open.map((q) => (
          <StaggerItem key={q.node.id}>
            <OpenQuestion question={q} />
          </StaggerItem>
        ))}
      </Stagger>

      {view.settled.length > 0 && (
        <section>
          <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Settled
          </span>
          <div className="mt-2 space-y-1.5">
            {view.settled.map((q) => (
              <SettledQuestion key={q.node.id} question={q} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function StateChip({ state }: { state: QuestionState }) {
  return (
    <span
      className={cn(
        "flex-shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium",
        STATE_CHIP[state],
      )}
    >
      {stateLabel(state)}
    </span>
  );
}

function OpenQuestion({ question }: { question: QuestionView }) {
  const addOption = useMutation(api.plans.addOption);
  const decide = useMutation(api.plans.decide);
  const accept = useMutation(api.plans.acceptDecision);
  const retract = useMutation(api.plans.retract);
  const { toast } = useToast();
  const [adding, setAdding] = useState(false);
  const [deciding, setDeciding] = useState<string | null>(null);

  const fail = (e: unknown, msg: string) =>
    toast(errorMessage(e, msg), { kind: "error" });

  return (
    <article className="bento rounded-2xl p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium leading-relaxed">
            {question.node.body}
          </p>
          <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <ActorGlyph
              name={question.node.authorName}
              isAgent={question.node.authorType === "agent"}
              size="sm"
            />
            {question.node.authorName} · {timeAgo(question.node.createdAt)}
            {question.node.needsHuman && " · a person settles this"}
          </p>
        </div>
        <StateChip state={question.state} />
      </div>

      {/* A machine reached a conclusion on a question a person reserved. */}
      {question.decision && question.decision.acceptedAt === null && (
        <div className="mt-3 rounded-lg bg-[var(--color-pastel-yellow)]/40 p-3">
          <p className="text-xs leading-relaxed">
            <span className="font-medium">
              {question.decision.authorName}
            </span>{" "}
            thinks this is settled: {question.decision.body}
          </p>
          <div className="mt-2 flex items-center gap-2">
            <Button
              size="sm"
              onClick={() =>
                void accept({
                  decisionId: question.decision!.id as Id<"planNodes">,
                }).catch((e) => fail(e, "Couldn't accept that"))
              }
            >
              Agreed
            </Button>
            <button
              type="button"
              onClick={() =>
                void retract({
                  nodeId: question.decision!.id as Id<"planNodes">,
                }).catch((e) => fail(e, "Couldn't set that aside"))
              }
              className="rounded-full px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
            >
              Not yet
            </button>
          </div>
        </div>
      )}

      {question.options.length > 0 && (
        <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {question.options.map((option) => (
            <Option
              key={option.node.id}
              option={option}
              onDecide={() => setDeciding(option.node.id)}
            />
          ))}
        </div>
      )}

      <div className="mt-3">
        {adding ? (
          <InlineCreate
            placeholder="Another way it could go…"
            onSubmit={async (body) => {
              await addOption({
                questionId: question.node.id as Id<"planNodes">,
                body,
              })
                .then(() => setAdding(false))
                .catch((e) => fail(e, "Couldn't add that"));
            }}
            onCancel={() => setAdding(false)}
          />
        ) : (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="text-[11px] text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground"
          >
            {question.options.length === 0
              ? "Offer an answer"
              : "Another answer"}
          </button>
        )}
      </div>

      <AnimatePresence>
        {deciding && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.25, ease: EASE }}
            className="overflow-hidden"
          >
            <div className="mt-3 rounded-lg bg-page p-3 ring-1 ring-border">
              <p className="text-[11px] text-muted-foreground">
                Settling it on:{" "}
                {
                  question.options.find((o) => o.node.id === deciding)?.node
                    .body
                }
              </p>
              <InlineCreate
                className="mt-2"
                placeholder="Why this one?"
                onSubmit={async (body) => {
                  await decide({
                    questionId: question.node.id as Id<"planNodes">,
                    chosenOptionId: deciding as Id<"planNodes">,
                    body,
                  })
                    .then(() => setDeciding(null))
                    .catch((e) => fail(e, "Couldn't settle that"));
                }}
                onCancel={() => setDeciding(null)}
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </article>
  );
}

function Option({
  option,
  onDecide,
}: {
  option: OptionView;
  onDecide: () => void;
}) {
  const addEvidence = useMutation(api.plans.addEvidence);
  const { toast } = useToast();
  const [stance, setStance] = useState<"supports" | "refutes" | "neutral" | null>(
    null,
  );

  return (
    <div
      className={cn(
        "bento-tile min-w-0 p-3",
        option.chosen && "ring-2 ring-foreground",
      )}
    >
      <p className="text-xs font-medium leading-relaxed">{option.node.body}</p>

      {/* The shape of the argument, before you read any of it. */}
      <p className="mt-1 text-[10px] tabular-nums text-muted-foreground">
        {option.evidence.length === 0
          ? "nothing said about this yet"
          : `${option.supports} for · ${option.refutes} against`}
      </p>

      {option.evidence.length > 0 && (
        <ul className="mt-2 space-y-1.5">
          {option.evidence.map((e) => (
            <li key={e.id} className="flex gap-1.5">
              {/* A mark rather than colour alone — the two have to be
                  distinguishable without seeing a difference in hue. */}
              <span
                aria-label={e.stance}
                className={cn(
                  "mt-[3px] flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center rounded-[4px] text-[9px] font-semibold leading-none",
                  e.stance === "supports" &&
                    "bg-[var(--color-pastel-green)] text-foreground",
                  e.stance === "refutes" &&
                    "bg-[var(--color-pastel-red)] text-foreground",
                  e.stance === "neutral" && "bg-muted text-muted-foreground",
                )}
              >
                {e.stance === "supports" ? "+" : e.stance === "refutes" ? "−" : "·"}
              </span>
              <span className="min-w-0 text-[11px] leading-relaxed">
                {e.body}
                <span className="text-muted-foreground"> — {e.authorName}</span>
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-1">
        {stance === null ? (
          <>
            {(["supports", "refutes"] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setStance(s)}
                className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
              >
                {s === "supports" ? "+ for" : "− against"}
              </button>
            ))}
            {!option.chosen && (
              <button
                type="button"
                onClick={onDecide}
                className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
              >
                go with this
              </button>
            )}
          </>
        ) : (
          <InlineCreate
            className="w-full"
            placeholder={
              stance === "supports" ? "What backs this up?" : "What's wrong with it?"
            }
            onSubmit={async (body) => {
              await addEvidence({
                optionId: option.node.id as Id<"planNodes">,
                body,
                stance,
              })
                .then(() => setStance(null))
                .catch((e) =>
                  toast(errorMessage(e, "Couldn't add that"), { kind: "error" }),
                );
            }}
            onCancel={() => setStance(null)}
          />
        )}
      </div>
    </div>
  );
}

/**
 * A settled question, as one line.
 *
 * The compression that makes a mature plan readable. Everything that produced
 * the answer is still here, one click down — but the default is the answer,
 * because that is what anybody arriving needs and re-reading the argument is
 * how a plan becomes a transcript again.
 */
function SettledQuestion({ question }: { question: QuestionView }) {
  const [open, setOpen] = useState(false);
  const retract = useMutation(api.plans.retract);
  const { toast } = useToast();
  const chosen = question.options.find((o) => o.chosen);

  return (
    <div className="bento-tile rounded-lg px-3 py-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-baseline gap-2 text-left"
      >
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {question.node.body}
        </span>
        <span className="min-w-0 flex-[2] truncate text-xs">
          {chosen?.node.body ?? question.decision?.body}
        </span>
        <span className="flex-shrink-0 text-[10px] text-muted-foreground">
          {question.decision?.acceptedByName ?? question.decision?.authorName}
        </span>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.25, ease: EASE }}
            className="overflow-hidden"
          >
            <Reveal className="pt-3">
              <p className="text-xs leading-relaxed">
                {question.decision?.body}
              </p>
              <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {question.options.map((option) => (
                  <Option key={option.node.id} option={option} onDecide={() => {}} />
                ))}
              </div>
              {/* Reopening is retracting the decision — no separate verb, and
                  the record of having once decided the other way survives. */}
              {question.decision && (
                <button
                  type="button"
                  onClick={() =>
                    void retract({
                      nodeId: question.decision!.id as Id<"planNodes">,
                    }).catch((e) =>
                      toast(errorMessage(e, "Couldn't reopen that"), {
                        kind: "error",
                      }),
                    )
                  }
                  className="mt-3 text-[11px] text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground"
                >
                  Reopen this
                </button>
              )}
            </Reveal>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function PlanSkeleton() {
  return (
    <div className="space-y-4">
      <div className="h-4 w-48 animate-pulse rounded bg-muted" />
      {[0, 1].map((i) => (
        <div key={i} className="bento space-y-3 rounded-2xl p-4">
          <div className="h-3 w-2/3 animate-pulse rounded bg-muted" />
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="h-20 animate-pulse rounded-lg bg-muted" />
            <div className="h-20 animate-pulse rounded-lg bg-muted" />
          </div>
        </div>
      ))}
    </div>
  );
}
