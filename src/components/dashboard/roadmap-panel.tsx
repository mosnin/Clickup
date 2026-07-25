"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery } from "convex/react";
import {
  BookOpen,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  MoreHorizontal,
  Plus,
  ShieldCheck,
  Trash2,
  XCircle,
} from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Picker } from "@/components/ui/picker";
import { InlineCreate } from "@/components/dashboard/inline-create";
import { useToast } from "@/components/toast";
import { cn } from "@/lib/utils";
import { fromDateInputValue, toDateInputValue } from "@/lib/dates";
import {
  AnimatedBar,
  AnimatePresence,
  EASE,
  motion,
  Stagger,
  StaggerItem,
} from "@/components/motion";
import { errorMessage } from "@/lib/errors";

// Roadmap tab on the workspace page: workspace lists slotted
// into the ordered phases of one or more roadmaps ("Now / Next / Later",
// quarters, launch trains…). Phases render as horizontal columns; lists
// move between phases, reorder within one, and fall back to the
// "Not on roadmap" rail at the bottom when unassigned. All data lives in
// convex/roadmaps.ts — this file is pure surface.

type RoadmapList = NonNullable<
  NonNullable<ReturnType<typeof useQuery<typeof api.roadmaps.listForWorkspace>>>
>;
type Roadmap = RoadmapList[number];
type Phase = Roadmap["phases"][number];
type RoadmapProject = Roadmap["projects"][number];

// Same pastel language as the list cards: dark ink stays pinned on
// pastel fills in both themes; "paused" rides the theme-adaptive muted pair.
const STATUS_CHIP: Record<
  NonNullable<RoadmapProject["projectStatus"]>,
  { label: string; className: string }
> = {
  on_track: { label: "On track", className: "bg-pastel-green dark:text-neutral-900" },
  at_risk: { label: "At risk", className: "bg-pastel-yellow dark:text-neutral-900" },
  off_track: { label: "Off track", className: "bg-pastel-red dark:text-neutral-900" },
  paused: { label: "Paused", className: "bg-muted text-muted-foreground" },
};

function fmtTarget(ts: number): string {
  const d = new Date(ts);
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
  return d.toLocaleDateString(undefined, opts);
}

function fmtExecutionTime(ts: number): string {
  const minutes = Math.max(0, Math.floor((Date.now() - ts) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function RoadmapPanel({ workspaceId }: { workspaceId: Id<"workspaces"> }) {
  const roadmaps = useQuery(api.roadmaps.listForWorkspace, { workspaceId });
  const executionPlans = useQuery(api.executionPlans.listForWorkspace, {
    workspaceId,
  });
  // The sidebar tree is already subscribed by the workspace page, so this
  // costs nothing extra — it's the source for the "Not on roadmap" rail.
  const tree = useQuery(api.sidebar.tree, {});
  const createRoadmap = useMutation(api.roadmaps.create);
  const updateRoadmap = useMutation(api.roadmaps.update);
  const removeRoadmap = useMutation(api.roadmaps.remove);
  const addPhase = useMutation(api.roadmaps.addPhase);
  const removePhase = useMutation(api.roadmaps.removePhase);
  const { toast } = useToast();

  const [activeId, setActiveId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [addingPhase, setAddingPhase] = useState(false);
  // Hidden while their undo toasts are live — deletes commit on expiry.
  const [hiddenRoadmapIds, setHiddenRoadmapIds] = useState<Set<string>>(
    new Set(),
  );
  const [hiddenPhaseIds, setHiddenPhaseIds] = useState<Set<string>>(new Set());

  // Workspace lists not assigned to any roadmap, for the bottom rail.
  const unassigned = useMemo(() => {
    const ws = tree?.workspaces.find((w) => w._id === workspaceId);
    if (!ws) return [];
    const rows: {
      listId: Id<"lists">;
      name: string;
      color?: string;
      spaceName: string;
    }[] = [];
    for (const sp of ws.spaces) {
      const lists = [...sp.lists, ...sp.folders.flatMap((f) => f.lists)];
      for (const l of lists) {
        if (l.roadmapId !== undefined) continue;
        rows.push({
          listId: l._id,
          name: l.name,
          color: l.color,
          spaceName: sp.name,
        });
      }
    }
    return rows;
  }, [tree, workspaceId]);

  if (
    roadmaps === undefined ||
    tree === undefined ||
    executionPlans === undefined
  ) {
    return (
      <div className="space-y-3">
        <div className="h-8 w-48 animate-pulse rounded-full bg-muted/40" />
        <div className="flex gap-3 overflow-hidden">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-56 w-72 flex-shrink-0 animate-pulse rounded-2xl bg-muted/30"
            />
          ))}
        </div>
      </div>
    );
  }
  if (roadmaps === null) return null;

  const visible = roadmaps.filter((r) => !hiddenRoadmapIds.has(r._id));
  const active = visible.find((r) => r._id === activeId) ?? visible[0];
  const provenance = active
    ? executionPlans.find((plan) => plan.roadmapId === active._id)
    : undefined;

  async function submitCreate(name: string) {
    try {
      const id = await createRoadmap({ workspaceId, name });
      setActiveId(id);
      setCreating(false);
    } catch (e) {
      toast(errorMessage(e, "Couldn't create roadmap"), { kind: "error" });
    }
  }

  if (!active) {
    return (
      <div className="rounded-2xl panel px-6 py-14 text-center">
        <p className="text-sm font-semibold">Plan the arc of the work</p>
        <p className="mx-auto mt-1.5 max-w-sm text-sm leading-relaxed text-muted-foreground">
          A roadmap sequences this workspace&apos;s lists into phases — Now,
          Next, Later — so everyone can see what ships when.
        </p>
        <div className="mt-4 flex justify-center">
          {creating ? (
            <InlineCreate
              placeholder="Roadmap name…"
              className="w-64"
              onCancel={() => setCreating(false)}
              onSubmit={submitCreate}
            />
          ) : (
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" /> New roadmap
            </Button>
          )}
        </div>
      </div>
    );
  }

  function deleteRoadmap(rm: Roadmap) {
    // Any open editors targeted the roadmap being deleted — close them so
    // they can't silently retarget whichever roadmap becomes active next.
    setRenaming(false);
    setAddingPhase(false);
    const unhide = () =>
      setHiddenRoadmapIds((prev) => {
        const next = new Set(prev);
        next.delete(rm._id);
        return next;
      });
    setHiddenRoadmapIds((prev) => new Set(prev).add(rm._id));
    toast(`${rm.name} deleted — lists stay put`, {
      action: { label: "Undo", onClick: unhide },
      onExpire: () =>
        void removeRoadmap({ roadmapId: rm._id }).catch((e) => {
          // Failed commit: un-hide so the still-existing roadmap reappears.
          unhide();
          toast(errorMessage(e, "Couldn't delete roadmap"), { kind: "error" });
        }),
    });
  }

  function deletePhase(rm: Roadmap, phase: Phase) {
    const unhide = () =>
      setHiddenPhaseIds((prev) => {
        const next = new Set(prev);
        next.delete(phase.id);
        return next;
      });
    setHiddenPhaseIds((prev) => new Set(prev).add(phase.id));
    const count = rm.projects.filter((p) => p.phaseId === phase.id).length;
    toast(
      count > 0
        ? `${phase.name} deleted — ${count} list${count === 1 ? "" : "s"} return to Not on roadmap`
        : `${phase.name} deleted`,
      {
        action: { label: "Undo", onClick: unhide },
        onExpire: () =>
          void removePhase({ roadmapId: rm._id, phaseId: phase.id }).catch(
            (e) => {
              unhide();
              toast(errorMessage(e, "Couldn't delete phase"), {
                kind: "error",
              });
            },
          ),
      },
    );
  }

  const phases = active.phases.filter((p) => !hiddenPhaseIds.has(p.id));
  const totalTasks = active.projects.reduce((sum, p) => sum + p.total, 0);
  const totalDone = active.projects.reduce((sum, p) => sum + p.done, 0);

  return (
    <div className="space-y-4">
      {/* Switcher: which roadmap, plus the affordance for another one. */}
      <div className="flex flex-wrap items-center gap-1.5">
        {visible.length > 1 &&
          visible.map((rm) => (
            <button
              key={rm._id}
              type="button"
              onClick={() => {
                setActiveId(rm._id);
                setRenaming(false);
                setAddingPhase(false);
              }}
              aria-current={rm._id === active._id ? "true" : undefined}
              className={cn(
                "rounded-full px-3 py-1 text-sm transition-colors",
                rm._id === active._id
                  ? "bg-foreground font-medium text-background"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              {rm.name}
            </button>
          ))}
        {creating ? (
          <InlineCreate
            placeholder="Roadmap name…"
            className="w-52"
            onCancel={() => setCreating(false)}
            onSubmit={submitCreate}
          />
        ) : (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="rounded-full panel px-3 py-1 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            + roadmap
          </button>
        )}
      </div>

      {/* Active roadmap header: inline rename, delete, rollup. */}
      <div className="flex flex-wrap items-center gap-2">
        {renaming ? (
          <InlineCreate
            placeholder="Roadmap name…"
            initialValue={active.name}
            className="w-64"
            onCancel={() => setRenaming(false)}
            onSubmit={async (name) => {
              try {
                await updateRoadmap({ roadmapId: active._id, name });
                setRenaming(false);
              } catch (e) {
                toast(errorMessage(e, "Couldn't rename roadmap"), {
                  kind: "error",
                });
              }
            }}
          />
        ) : (
          <button
            type="button"
            title="Rename roadmap"
            onClick={() => setRenaming(true)}
            className="max-w-full truncate text-left text-base font-semibold hover:underline"
          >
            {active.name}
          </button>
        )}
        {totalTasks > 0 && (
          <span className="text-xs text-muted-foreground">
            {totalDone}/{totalTasks} tasks done · {active.projects.length}{" "}
            list{active.projects.length === 1 ? "" : "s"}
          </span>
        )}
        <button
          type="button"
          title="Delete roadmap (lists are kept)"
          onClick={() => deleteRoadmap(active)}
          className="tap-target ml-auto inline-flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-red-600"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      {active.description && (
        <p className="-mt-2 text-sm text-muted-foreground">
          {active.description}
        </p>
      )}
      {provenance && (
        <ExecutionPlanProvenance planId={provenance.planId} />
      )}

      {/* Phase columns — horizontal scroll, like the other pill rows. */}
      <div className="-mx-4 overflow-x-auto overscroll-x-contain px-4 pb-2 sm:-mx-6 sm:px-6">
        <Stagger key={active._id} className="flex items-start gap-3">
          {phases.map((phase) => (
            <StaggerItem key={phase.id} className="w-64 flex-shrink-0 sm:w-72">
              <PhaseColumn
                roadmap={active}
                phase={phase}
                visiblePhases={phases}
                projects={active.projects.filter(
                  (p) => p.phaseId === phase.id,
                )}
                onDelete={() => deletePhase(active, phase)}
              />
            </StaggerItem>
          ))}
          <div className="w-64 flex-shrink-0 pt-1">
            {addingPhase ? (
              <InlineCreate
                placeholder="Phase name…"
                onCancel={() => setAddingPhase(false)}
                onSubmit={async (name) => {
                  try {
                    await addPhase({ roadmapId: active._id, name });
                    setAddingPhase(false);
                  } catch (e) {
                    toast(errorMessage(e, "Couldn't add phase"), {
                      kind: "error",
                    });
                  }
                }}
              />
            ) : (
              <button
                type="button"
                onClick={() => setAddingPhase(true)}
                className="w-full rounded-2xl panel px-3 py-2.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                + Add phase
              </button>
            )}
          </div>
        </Stagger>
      </div>

      <UnassignedRail
        // During a phase's undo window its projects would otherwise be
        // invisible everywhere — surface them here (they're headed to the
        // rail anyway if the delete commits).
        projects={[
          ...unassigned,
          ...active.projects
            .filter(
              (p) => p.phaseId !== undefined && hiddenPhaseIds.has(p.phaseId),
            )
            .map((p) => ({
              listId: p.listId,
              name: p.name,
              color: p.color,
              spaceName: "",
            })),
        ]}
        roadmap={active}
        phases={phases}
      />
    </div>
  );
}

function ExecutionPlanProvenance({
  planId,
}: {
  planId: Id<"executionPlans">;
}) {
  const plan = useQuery(api.executionPlans.get, { planId });
  const readiness = useQuery(api.executionDispatch.readiness, { planId });
  const control = useQuery(api.executionDispatch.control, { planId });
  const assurance = useQuery(api.outcomeAssurance.get, { planId });
  const reviewPlan = useMutation(api.executionPlans.review);
  const reviewOutcome = useMutation(api.outcomeAssurance.review);
  const { toast } = useToast();
  const [authorizationNote, setAuthorizationNote] = useState("");
  const [authorizing, setAuthorizing] = useState(false);
  const [reviewingIndex, setReviewingIndex] = useState<number | null>(null);
  const [reviewNote, setReviewNote] = useState("");
  const [reviewing, setReviewing] = useState(false);
  if (!plan) return null;

  async function commitAuthorization(
    decision: "approved" | "rejected",
  ) {
    if (authorizationNote.trim().length < 10) {
      toast("Add a short note explaining the authorization decision.", {
        kind: "error",
      });
      return;
    }
    setAuthorizing(true);
    try {
      await reviewPlan({
        planId,
        decision,
        note: authorizationNote,
      });
      toast(
        decision === "approved"
          ? "Execution plan approved for dispatch."
          : "Execution plan rejected. Future dispatch is blocked.",
        { kind: decision === "approved" ? "success" : "error" },
      );
      setAuthorizationNote("");
    } catch (error) {
      toast(errorMessage(error, "Couldn't review the execution plan"), {
        kind: "error",
      });
    } finally {
      setAuthorizing(false);
    }
  }

  async function commitReview(
    criterionIndex: number,
    verdict: "passed" | "failed",
  ) {
    if (!reviewNote.trim()) {
      toast("Add a review note explaining the decision.", { kind: "error" });
      return;
    }
    setReviewing(true);
    try {
      await reviewOutcome({
        planId,
        criterionIndex,
        verdict,
        reviewNote,
      });
      toast(
        verdict === "passed"
          ? "Outcome criterion independently verified."
          : "Outcome criterion failed review.",
        { kind: verdict === "passed" ? "success" : "error" },
      );
      setReviewingIndex(null);
      setReviewNote("");
    } catch (error) {
      toast(errorMessage(error, "Couldn't record the review"), {
        kind: "error",
      });
    } finally {
      setReviewing(false);
    }
  }

  return (
    <details className="group rounded-2xl border border-brand-500/20 bg-brand-500/[0.04]">
      <summary className="flex cursor-pointer list-none items-start gap-3 px-4 py-3">
        <span className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-brand-500/10 text-brand-600 dark:text-brand-400">
          <BookOpen className="h-3.5 w-3.5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-sm font-semibold">Compiled from source</span>
            <span className="text-xs text-muted-foreground">
              {plan.projectCount} workstreams · {plan.taskCount} tasks
            </span>
            {plan.openQuestionCount > 0 && (
              <span className="rounded-full bg-pastel-yellow px-2 py-0.5 text-[11px] font-medium text-neutral-900">
                {plan.openQuestionCount} open question
                {plan.openQuestionCount === 1 ? "" : "s"}
              </span>
            )}
            {plan.contextRevision > 0 && (
              <span className="rounded-full bg-brand-500/10 px-2 py-0.5 text-[11px] font-medium text-brand-700 dark:text-brand-300">
                context v{plan.contextRevision + 1}
              </span>
            )}
          </span>
          <span className="mt-1 block text-sm text-foreground/80">
            {plan.objective}
          </span>
        </span>
        <ChevronDown className="mt-1 h-4 w-4 flex-shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
      </summary>
      <div className="grid gap-4 border-t border-brand-500/15 px-4 py-4 text-sm md:grid-cols-2">
        <div className="md:col-span-2 rounded-xl border border-border bg-background/60 p-3">
          <div className="flex flex-wrap items-start gap-3">
            <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-brand-500/10 text-brand-600 dark:text-brand-400">
              <ShieldCheck className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Dispatch authorization
                </p>
                <span
                  className={cn(
                    "rounded-full px-2 py-0.5 text-[11px] font-medium capitalize text-neutral-900",
                    readiness &&
                    !readiness.dispatchAuthorized &&
                    plan.reviewStatus === "approved"
                      ? "bg-pastel-yellow"
                      : plan.reviewStatus === "approved" ||
                          plan.reviewStatus === "legacy_approved"
                      ? "bg-pastel-green"
                      : plan.reviewStatus === "rejected"
                        ? "bg-pastel-red"
                        : "bg-pastel-yellow",
                  )}
                >
                  {readiness &&
                  !readiness.dispatchAuthorized &&
                  plan.reviewStatus === "approved"
                    ? "Needs revalidation"
                    : plan.authorizationSource === "workspace_policy"
                      ? "Policy authorized"
                      : plan.reviewStatus === "legacy_approved"
                        ? "Previously authorized"
                        : plan.reviewStatus}
                </span>
              </div>
              <p className="mt-1 text-xs text-foreground/70">
                {readiness?.authorization.reason ??
                (plan.reviewStatus === "pending"
                  ? "An owner or admin must review this plan before agents can dispatch its tasks."
                  : plan.reviewStatus === "rejected"
                    ? "Future dispatch is blocked until an owner or admin approves this plan."
                    : "This plan is authorized for agent dispatch. Open questions still require an explicit disposition.")}
              </p>
            </div>
          </div>
          {plan.canReview && (
            <div className="mt-3 space-y-2">
              <textarea
                value={authorizationNote}
                onChange={(event) =>
                  setAuthorizationNote(event.target.value)
                }
                placeholder="Record what you reviewed and why this plan should proceed or be revised."
                rows={2}
                className="w-full resize-y rounded-lg border border-border bg-background px-2.5 py-2 text-xs outline-none transition focus:border-brand-500"
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  disabled={authorizing}
                  onClick={() => void commitAuthorization("approved")}
                >
                  Approve dispatch
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={authorizing}
                  onClick={() => void commitAuthorization("rejected")}
                >
                  Reject plan
                </Button>
              </div>
            </div>
          )}
          {plan.reviews.length > 0 && (
            <ul className="mt-3 space-y-1.5 border-t border-border/70 pt-3">
              {plan.reviews.slice(0, 3).map((review) => (
                <li
                  key={review.reviewId}
                  className="text-[11px] leading-4 text-muted-foreground"
                >
                  <span className="font-medium text-foreground/80">
                    {review.reviewerName}
                  </span>{" "}
                  {review.decision} this plan ·{" "}
                  {fmtExecutionTime(review.reviewedAt)}
                  <span className="block pl-2">“{review.note}”</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Success criteria
          </p>
          <ul className="mt-2 space-y-1.5 text-foreground/80">
            {plan.successCriteria.map((criterion, index) => (
              <li key={`${index}-${criterion}`}>• {criterion}</li>
            ))}
          </ul>
        </div>
        {assurance && (
          <div className="md:col-span-2 rounded-xl border border-border bg-background/60 p-3">
            <div className="flex flex-wrap items-start gap-2">
              <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-brand-500/10 text-brand-600 dark:text-brand-400">
                <ShieldCheck className="h-3.5 w-3.5" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Outcome assurance
                  </p>
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 text-[11px] font-medium capitalize text-neutral-900",
                      assurance.status === "verified"
                        ? "bg-pastel-green"
                        : assurance.status === "failed"
                          ? "bg-pastel-red"
                          : assurance.status === "in_review"
                            ? "bg-pastel-yellow"
                            : "bg-muted text-muted-foreground",
                    )}
                  >
                    {assurance.status.replace("_", " ")}
                  </span>
                  <span className="text-[11px] text-muted-foreground">
                    {assurance.passed}/{assurance.total} independently verified
                  </span>
                </div>
                <p className="mt-1 text-xs text-foreground/70">
                  Finished tasks prove activity. This gate proves the original
                  objective against concrete evidence.
                </p>
              </div>
            </div>
            <ul className="mt-3 space-y-2">
              {assurance.checks.map((check) => (
                <li
                  key={check.criterionIndex}
                  className="rounded-xl border border-border/70 px-3 py-2.5"
                >
                  <div className="flex min-w-0 items-start gap-2">
                    {check.status === "passed" ? (
                      <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0 text-emerald-600" />
                    ) : check.status === "failed" ? (
                      <XCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-red-600" />
                    ) : (
                      <span className="mt-1 h-3 w-3 flex-shrink-0 rounded-full border border-muted-foreground/40" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-start gap-x-2 gap-y-1">
                        <p className="min-w-0 flex-1 text-xs font-medium">
                          {check.criterion}
                        </p>
                        <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium capitalize text-muted-foreground">
                          {check.status}
                        </span>
                      </div>
                      {check.evidenceSummary && (
                        <p className="mt-1.5 text-[11px] leading-4 text-foreground/70">
                          {check.evidenceSummary}
                        </p>
                      )}
                      {check.evidenceLinks.length > 0 && (
                        <div className="mt-1.5 flex flex-wrap gap-2">
                          {check.evidenceLinks.map((link, index) => (
                            <a
                              key={`${index}-${link}`}
                              href={link}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1 text-[11px] font-medium text-brand-600 hover:underline dark:text-brand-400"
                            >
                              Evidence {index + 1}
                              <ExternalLink className="h-2.5 w-2.5" />
                            </a>
                          ))}
                        </div>
                      )}
                      {check.reviewNote && (
                        <p className="mt-1.5 text-[11px] text-muted-foreground">
                          Review by {check.reviewerName ?? "reviewer"}:{" "}
                          {check.reviewNote}
                        </p>
                      )}
                      {check.staleDueToContextRevision && (
                        <p className="mt-1.5 rounded-lg bg-pastel-yellow px-2 py-1.5 text-[11px] text-neutral-900">
                          Plan context changed after this evidence was
                          submitted. Submit current evidence before review.
                        </p>
                      )}
                      {check.status === "submitted" &&
                        reviewingIndex !== check.criterionIndex && (
                          <button
                            type="button"
                            onClick={() => {
                              setReviewingIndex(check.criterionIndex);
                              setReviewNote("");
                            }}
                            className="mt-2 text-[11px] font-semibold text-brand-600 hover:underline dark:text-brand-400"
                          >
                            Review evidence
                          </button>
                        )}
                      {reviewingIndex === check.criterionIndex && (
                        <div className="mt-2 space-y-2">
                          <textarea
                            value={reviewNote}
                            onChange={(event) =>
                              setReviewNote(event.target.value)
                            }
                            placeholder="What did you verify, and why does the evidence pass or fail?"
                            rows={2}
                            className="w-full resize-y rounded-lg border border-border bg-background px-2.5 py-2 text-xs outline-none transition focus:border-brand-500"
                          />
                          <div className="flex flex-wrap gap-2">
                            <Button
                              type="button"
                              size="sm"
                              disabled={reviewing}
                              onClick={() =>
                                void commitReview(
                                  check.criterionIndex,
                                  "passed",
                                )
                              }
                            >
                              Pass criterion
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              disabled={reviewing}
                              onClick={() =>
                                void commitReview(
                                  check.criterionIndex,
                                  "failed",
                                )
                              }
                            >
                              Fail review
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              disabled={reviewing}
                              onClick={() => {
                                setReviewingIndex(null);
                                setReviewNote("");
                              }}
                            >
                              Cancel
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="space-y-4">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Explicit assumptions
            </p>
            <ul className="mt-2 space-y-1.5 text-foreground/80">
              {plan.assumptions.length > 0 ? (
                plan.assumptions.map((assumption, index) => (
                  <li key={`${index}-${assumption}`}>• {assumption}</li>
                ))
              ) : (
                <li>None recorded.</li>
              )}
            </ul>
          </div>
          {plan.openQuestions.length > 0 && (
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Open questions
              </p>
              <ul className="mt-2 space-y-1.5 text-foreground/80">
                {plan.openQuestions.map((question, index) => (
                  <li key={`${index}-${question}`}>• {question}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
        <div className="md:col-span-2">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Confirmed source
          </p>
          <pre className="mt-2 max-h-56 overflow-y-auto whitespace-pre-wrap rounded-xl bg-background/70 p-3 font-sans text-xs leading-5 text-foreground/75">
            {plan.sourceContext}
          </pre>
        </div>
        {plan.revisions.length > 0 && (
          <div className="md:col-span-2">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Context revisions
            </p>
            <p className="mt-1 text-xs text-foreground/70">
              Every revision advanced all workstream packets together and
              required agents to acknowledge the new versions.
            </p>
            <ol className="mt-2 space-y-2">
              {plan.revisions.map((revision) => (
                <li
                  key={revision.revisionId}
                  className="rounded-xl border border-border/70 bg-background/50 px-3 py-2.5"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-semibold">
                      Revision {revision.revision}
                    </span>
                    <span className="text-[11px] text-muted-foreground">
                      {fmtExecutionTime(revision.createdAt)} ·{" "}
                      {revision.affectedPacketCount} workstreams ·{" "}
                      {revision.affectedTaskCount} tasks revalidated
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-foreground/80">
                    {revision.changeSummary}
                  </p>
                  <pre className="mt-2 max-h-36 overflow-y-auto whitespace-pre-wrap rounded-lg bg-muted/40 p-2.5 font-sans text-[11px] leading-4 text-foreground/70">
                    {revision.sourceAddendum}
                  </pre>
                </li>
              ))}
            </ol>
          </div>
        )}
        {readiness && (
          <div className="md:col-span-2 rounded-xl border border-border bg-background/50 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Next dispatch wave
              </p>
              <span
                className={cn(
                  "rounded-full px-2 py-0.5 text-[11px] font-medium text-neutral-900",
                  readiness.dispatchAuthorized
                    ? "bg-pastel-green"
                    : "bg-pastel-yellow",
                )}
              >
                {readiness.recommendations.length}{" "}
                {readiness.dispatchAuthorized
                  ? "ready"
                  : "ready after approval"}
              </span>
              {readiness.skipped.filter(
                (item) => item.reason === "capability_gap",
              ).length > 0 && (
                <span className="rounded-full bg-pastel-red px-2 py-0.5 text-[11px] font-medium text-neutral-900">
                  {
                    readiness.skipped.filter(
                      (item) => item.reason === "capability_gap",
                    ).length
                  }{" "}
                  capability gap
                </span>
              )}
              <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                {readiness.policyCapacityRemaining} policy capacity · 24h
              </span>
              {readiness.skipped.filter(
                (item) => item.reason === "capacity_exhausted",
              ).length > 0 && (
                <span className="rounded-full bg-pastel-yellow px-2 py-0.5 text-[11px] font-medium text-neutral-900">
                  {
                    readiness.skipped.filter(
                      (item) => item.reason === "capacity_exhausted",
                    ).length
                  }{" "}
                  waiting for capacity
                </span>
              )}
            </div>
            {readiness.requiresOpenQuestionDisposition && (
              <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
                Dispatch is gated until the open questions have an explicit
                resolved, deferred, or bounded disposition.
              </p>
            )}
            {plan.reviewStatus === "pending" && (
              <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
                Dispatch is gated until an owner or admin approves this plan.
              </p>
            )}
            {plan.reviewStatus === "rejected" && (
              <p className="mt-2 text-xs text-red-700 dark:text-red-300">
                Dispatch is blocked because this plan was rejected.
              </p>
            )}
            {!readiness.dispatchAuthorized &&
              plan.reviewStatus === "approved" && (
                <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
                  Dispatch is gated because the workspace autonomy policy
                  changed. A fresh human approval restores authorization.
                </p>
              )}
            {readiness.recommendations.length > 0 ? (
              <ul className="mt-3 grid gap-2 sm:grid-cols-2">
                {readiness.recommendations.slice(0, 6).map((item) => (
                  <li
                    key={item.taskId}
                    className="flex min-w-0 items-center gap-2 rounded-xl border border-border/70 px-3 py-2"
                  >
                    <span className="min-w-0 flex-1 truncate text-xs font-medium">
                      {item.title}
                    </span>
                    <span className="flex-shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px]">
                      {item.recommendedAgentName}
                    </span>
                    {!item.notifyConfigured && (
                      <span
                        title="This runtime must poll next_task because it has no notify URL."
                        className="flex-shrink-0 text-[10px] uppercase tracking-wider text-muted-foreground"
                      >
                        poll
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-xs text-muted-foreground">
                No undispatched work is ready within current dependencies,
                capabilities, leases, and concurrency limits.
              </p>
            )}
            {readiness.waves.length > 0 && (
              <p className="mt-3 text-xs text-muted-foreground">
                Last wave sent {readiness.waves[0].assignmentCount} task
                {readiness.waves[0].assignmentCount === 1 ? "" : "s"}
                {readiness.waves[0].pollRequiredCount > 0
                  ? ` · ${readiness.waves[0].pollRequiredCount} runtime${readiness.waves[0].pollRequiredCount === 1 ? "" : "s"} must poll`
                  : " · every runtime notified"}
              </p>
            )}
          </div>
        )}
        {control && control.assignmentCount > 0 && (
          <div className="md:col-span-2 rounded-xl border border-border bg-background/50 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <p className="mr-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Execution ledger
              </p>
              {(
                [
                  ["running", control.counts.running, "bg-pastel-blue"],
                  ["claimed", control.counts.claimed, "bg-pastel-purple"],
                  ["sent", control.counts.dispatched, "bg-muted"],
                  ["succeeded", control.counts.succeeded, "bg-pastel-green"],
                  ["failed", control.counts.failed, "bg-pastel-red"],
                  ["stale", control.staleCount, "bg-pastel-yellow"],
                  ["retryable", control.counts.abandoned, "bg-pastel-yellow"],
                ] as const
              ).map(([label, count, className]) =>
                count > 0 ? (
                  <span
                    key={label}
                    className={cn(
                      "rounded-full px-2 py-0.5 text-[11px] font-medium text-neutral-900",
                      className,
                    )}
                  >
                    {count} {label}
                  </span>
                ) : null,
              )}
            </div>
            <ul className="mt-3 grid gap-2 sm:grid-cols-2">
              {control.assignments.slice(0, 6).map((assignment) => (
                <li
                  key={assignment.assignmentId}
                  className="min-w-0 rounded-xl border border-border/70 px-3 py-2"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-xs font-medium">
                      {assignment.taskTitle}
                    </span>
                    <span className="flex-shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] capitalize">
                      {assignment.status}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
                    <span>{assignment.agentName}</span>
                    <span>attempt {assignment.attempt}</span>
                    <span>
                      {fmtExecutionTime(
                        assignment.finishedAt ??
                          assignment.lastHeartbeatAt ??
                          assignment.dispatchedAt,
                      )}
                    </span>
                    {assignment.delivery === "poll_required" && (
                      <span className="uppercase tracking-wider">poll</span>
                    )}
                  </div>
                  {(assignment.error || assignment.summary) && (
                    <p
                      className={cn(
                        "mt-1.5 line-clamp-2 text-[11px]",
                        assignment.error
                          ? "text-red-700 dark:text-red-300"
                          : "text-foreground/70",
                      )}
                    >
                      {assignment.error ?? assignment.summary}
                    </p>
                  )}
                  {assignment.links.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-2">
                      {assignment.links.slice(0, 3).map((link, index) => (
                        <a
                          key={`${index}-${link}`}
                          href={link}
                          target="_blank"
                          rel="noreferrer"
                          className="text-[11px] font-medium text-brand-600 hover:underline dark:text-brand-400"
                        >
                          Evidence {index + 1}
                        </a>
                      ))}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </details>
  );
}

// ── Phase column ─────────────────────────────────────────────────────────

function PhaseColumn({
  roadmap,
  phase,
  visiblePhases,
  projects,
  onDelete,
}: {
  roadmap: Roadmap;
  phase: Phase;
  /** Phases not pending deletion — the only valid move targets. */
  visiblePhases: Phase[];
  projects: RoadmapProject[];
  onDelete: () => void;
}) {
  const reorder = useMutation(api.roadmaps.reorderPhase);
  const assign = useMutation(api.roadmaps.assignProject);
  const updatePhase = useMutation(api.roadmaps.updatePhase);
  const { toast } = useToast();
  const [renaming, setRenaming] = useState(false);

  // Optimistic order: render the just-clicked order immediately, then let
  // the server's order take back over once it catches up (or the phase's
  // membership changes under us).
  const [override, setOverride] = useState<string[] | null>(null);
  const serverKey = projects.map((p) => p.listId as string).join(",");
  useEffect(() => {
    setOverride((cur) => {
      if (!cur) return cur;
      const serverIds = serverKey ? serverKey.split(",") : [];
      const sameSet =
        cur.length === serverIds.length &&
        cur.every((id) => serverIds.includes(id));
      if (!sameSet || cur.join(",") === serverKey) return null;
      return cur;
    });
  }, [serverKey]);

  const ordered = useMemo(() => {
    if (!override) return projects;
    const byId = new Map(projects.map((p) => [p.listId as string, p]));
    const out: RoadmapProject[] = [];
    for (const id of override) {
      const p = byId.get(id);
      if (p) {
        out.push(p);
        byId.delete(id);
      }
    }
    out.push(...byId.values());
    return out;
  }, [projects, override]);

  function move(index: number, dir: -1 | 1) {
    const ids = ordered.map((p) => p.listId);
    const j = index + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[index], ids[j]] = [ids[j], ids[index]];
    setOverride(ids as string[]);
    void reorder({
      roadmapId: roadmap._id,
      phaseId: phase.id,
      orderedIds: ids,
    }).catch((e) => {
      setOverride(null);
      toast(errorMessage(e, "Couldn't reorder lists"), { kind: "error" });
    });
  }

  function moveToPhase(project: RoadmapProject, targetId: string) {
    const action =
      targetId === "__remove"
        ? assign({ listId: project.listId, roadmapId: null })
        : assign({
            listId: project.listId,
            roadmapId: roadmap._id,
            phaseId: targetId,
          });
    void action.catch((e) =>
      toast(errorMessage(e, "Couldn't move list"), { kind: "error" }),
    );
  }

  const done = projects.reduce((sum, p) => sum + p.done, 0);
  const total = projects.reduce((sum, p) => sum + p.total, 0);
  const pct = total > 0 ? (done / total) * 100 : 0;
  const overdue =
    phase.targetDate !== undefined &&
    phase.targetDate < Date.now() &&
    done < total;

  const moveOptions = [
    ...visiblePhases
      .filter((p) => p.id !== phase.id)
      .map((p) => ({ id: p.id, label: p.name, hint: "phase" })),
    { id: "__remove", label: "Remove from roadmap" },
  ];

  return (
    <div className="rounded-2xl panel p-3">
      <div className="flex items-center gap-2">
        {renaming ? (
          <InlineCreate
            placeholder="Phase name…"
            initialValue={phase.name}
            className="min-w-0 flex-1"
            onCancel={() => setRenaming(false)}
            onSubmit={async (name) => {
              try {
                await updatePhase({
                  roadmapId: roadmap._id,
                  phaseId: phase.id,
                  name,
                });
                setRenaming(false);
              } catch (e) {
                toast(errorMessage(e, "Couldn't rename phase"), {
                  kind: "error",
                });
              }
            }}
          />
        ) : (
          <button
            type="button"
            title="Rename phase"
            onClick={() => setRenaming(true)}
            className="min-w-0 truncate text-sm font-semibold hover:underline"
          >
            {phase.name}
          </button>
        )}
        <span className="ml-auto flex-shrink-0 text-xs text-muted-foreground">
          {done}/{total}
        </span>
        <PhaseMenu
          roadmap={roadmap}
          phase={phase}
          onRename={() => setRenaming(true)}
          onDelete={onDelete}
        />
      </div>
      {phase.targetDate !== undefined && (
        <p
          className={cn(
            "mt-0.5 text-[11px] uppercase tracking-wider",
            overdue ? "font-medium text-danger" : "text-muted-foreground",
          )}
        >
          Target {fmtTarget(phase.targetDate)}
        </p>
      )}
      <AnimatedBar
        pct={pct}
        className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"
        barClassName="h-full rounded-full bg-foreground/70"
      />

      <div className="mt-3 space-y-2">
        {ordered.length === 0 && (
          <p className="px-1 py-2 text-xs text-muted-foreground">
            Nothing in this phase yet — move a list here.
          </p>
        )}
        <AnimatePresence initial={false}>
          {ordered.map((project, i) => (
            <motion.div
              key={project.listId}
              layout
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.97 }}
              transition={{ duration: 0.25, ease: EASE }}
            >
              <ProjectCard
                project={project}
                canUp={i > 0}
                canDown={i < ordered.length - 1}
                onUp={() => move(i, -1)}
                onDown={() => move(i, 1)}
                moveOptions={moveOptions}
                onMoveTo={(target) => moveToPhase(project, target)}
              />
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}

// ── Phase options menu ───────────────────────────────────────────────────

function PhaseMenu({
  roadmap,
  phase,
  onRename,
  onDelete,
}: {
  roadmap: Roadmap;
  phase: Phase;
  onRename: () => void;
  onDelete: () => void;
}) {
  const updatePhase = useMutation(api.roadmaps.updatePhase);
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  // Local draft so keyboard edits don't fire a mutation per segment (and
  // don't snap back mid-edit); committed on blur or menu close. Clearing
  // happens only via the explicit button — a transiently empty input while
  // retyping must never wipe the stored date.
  const [dateDraft, setDateDraft] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });

  // Portaled to <body>: the phase strip is overflow-x-auto, which would
  // clip an absolutely positioned menu (overflow-x forces overflow-y).
  useLayoutEffect(() => {
    if (!open) return;
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = 224; // w-56
    const left = Math.max(
      8,
      Math.min(rect.right - width, window.innerWidth - width - 8),
    );
    setPos({ top: rect.bottom + 6, left });
  }, [open]);

  const commitDraft = useCallback(() => {
    setDateDraft((draft) => {
      if (draft !== null && draft !== "") {
        void updatePhase({
          roadmapId: roadmap._id,
          phaseId: phase.id,
          targetDate: fromDateInputValue(draft) ?? null,
        }).catch((e) =>
          toast(errorMessage(e, "Couldn't set target date"), {
            kind: "error",
          }),
        );
      }
      return null;
    });
  }, [updatePhase, roadmap._id, phase.id, toast]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      const target = e.target as Node;
      if (rootRef.current?.contains(target)) return;
      if (popRef.current?.contains(target)) return;
      commitDraft();
      setOpen(false);
    }
    function onMove(e: Event) {
      if (e.target instanceof Node && popRef.current?.contains(e.target)) {
        return;
      }
      commitDraft();
      setOpen(false);
    }
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [open, commitDraft]);

  function clearTarget() {
    setDateDraft(null);
    void updatePhase({
      roadmapId: roadmap._id,
      phaseId: phase.id,
      targetDate: null,
    }).catch((e) =>
      toast(errorMessage(e, "Couldn't clear target date"), { kind: "error" }),
    );
  }

  return (
    <div ref={rootRef} className="relative flex-shrink-0">
      <button
        type="button"
        aria-label={`Options for ${phase.name}`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="tap-target inline-flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <MoreHorizontal className="h-3.5 w-3.5" />
      </button>
      {typeof document !== "undefined" &&
        createPortal(
          <AnimatePresence>
            {open && (
              <div
                ref={popRef}
                style={{
                  position: "fixed",
                  top: pos.top,
                  left: pos.left,
                  zIndex: 60,
                }}
              >
                <motion.div
                  initial={{ opacity: 0, y: 4, scale: 0.98 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 4, scale: 0.98 }}
                  transition={{ duration: 0.18, ease: EASE }}
                  className="w-56 rounded-2xl border border-border bg-popover p-2 text-popover-foreground shadow-lg"
                >
            <label className="block px-1.5 pt-1">
              <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Target date
              </span>
              <input
                type="date"
                value={
                  dateDraft ??
                  (phase.targetDate !== undefined
                    ? toDateInputValue(phase.targetDate)
                    : "")
                }
                onChange={(e) => setDateDraft(e.currentTarget.value)}
                onBlur={commitDraft}
                className="soft-field w-full px-3 py-1.5 text-sm"
              />
            </label>
            {phase.targetDate !== undefined && (
              <button
                type="button"
                onClick={clearTarget}
                className="mt-1 flex w-full items-center rounded-lg px-2.5 py-1.5 text-left text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              >
                Clear target date
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onRename();
              }}
              className="mt-1 flex w-full items-center rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
            >
              Rename phase
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onDelete();
              }}
              className="flex w-full items-center rounded-lg px-2.5 py-1.5 text-left text-sm text-red-600 hover:bg-accent"
            >
              Delete phase
            </button>
                </motion.div>
              </div>
            )}
          </AnimatePresence>,
          document.body,
        )}
    </div>
  );
}

// ── Project card ─────────────────────────────────────────────────────────

function ProjectCard({
  project,
  canUp,
  canDown,
  onUp,
  onDown,
  moveOptions,
  onMoveTo,
}: {
  project: RoadmapProject;
  canUp: boolean;
  canDown: boolean;
  onUp: () => void;
  onDown: () => void;
  moveOptions: { id: string; label: string; hint?: string }[];
  onMoveTo: (targetId: string) => void;
}) {
  const chip = project.projectStatus
    ? STATUS_CHIP[project.projectStatus]
    : null;

  return (
    <div className="bento-tile p-3">
      <div className="flex items-start gap-2">
        {project.color && (
          <span
            aria-hidden
            className="mt-1.5 h-2 w-2 flex-shrink-0 rounded-full"
            style={{ backgroundColor: project.color }}
          />
        )}
        <Link
          href={`/dashboard/l/${project.listId}`}
          className="min-w-0 flex-1 truncate text-sm font-medium hover:underline"
          title={project.name}
        >
          {project.name}
        </Link>
        <div className="flex flex-shrink-0 items-center">
          <button
            type="button"
            aria-label={`Move ${project.name} up`}
            disabled={!canUp}
            onClick={onUp}
            className="tap-target inline-flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground hover:bg-background hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent"
          >
            <ChevronUp className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            aria-label={`Move ${project.name} down`}
            disabled={!canDown}
            onClick={onDown}
            className="tap-target inline-flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground hover:bg-background hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent"
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
        {chip && (
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-[10px] font-medium",
              chip.className,
            )}
          >
            {chip.label}
          </span>
        )}
        <span className="text-xs text-muted-foreground">
          {project.done}/{project.total} done
        </span>
        {project.targetDate !== undefined && (
          <span className="text-xs text-muted-foreground">
            {fmtTarget(project.targetDate)}
          </span>
        )}
        <Picker
          label="Move"
          options={moveOptions}
          onSelect={onMoveTo}
          className="ml-auto"
        />
      </div>
    </div>
  );
}

// ── "Not on roadmap" rail ────────────────────────────────────────────────

function UnassignedRail({
  projects,
  roadmap,
  phases,
}: {
  projects: { listId: Id<"lists">; name: string; color?: string; spaceName: string }[];
  roadmap: Roadmap;
  /** Phases not pending deletion — the only valid assignment targets. */
  phases: Phase[];
}) {
  const assign = useMutation(api.roadmaps.assignProject);
  const { toast } = useToast();

  return (
    <section className="rounded-2xl panel p-4">
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Not on roadmap
      </p>
      {projects.length === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Every list in this workspace is on a roadmap.
        </p>
      ) : (
        <ul className="mt-3 space-y-1">
          <AnimatePresence initial={false}>
            {projects.map((p) => (
              <motion.li
                key={p.listId}
                layout
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.97 }}
                transition={{ duration: 0.25, ease: EASE }}
                className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg px-1 py-1"
              >
                {p.color && (
                  <span
                    aria-hidden
                    className="h-2 w-2 flex-shrink-0 rounded-full"
                    style={{ backgroundColor: p.color }}
                  />
                )}
                <Link
                  href={`/dashboard/l/${p.listId}`}
                  className="min-w-0 truncate text-sm font-medium hover:underline"
                  title={p.name}
                >
                  {p.name}
                </Link>
                {p.spaceName && (
                  <span className="truncate text-[11px] uppercase tracking-wider text-muted-foreground">
                    {p.spaceName}
                  </span>
                )}
                <Picker
                  label="+ Add to phase…"
                  dashed
                  className="ml-auto"
                  options={phases.map((ph) => ({
                    id: ph.id,
                    label: ph.name,
                  }))}
                  onSelect={(phaseId) =>
                    void assign({
                      listId: p.listId,
                      roadmapId: roadmap._id,
                      phaseId,
                    }).catch((e) =>
                      toast(errorMessage(e, "Couldn't add to roadmap"), {
                        kind: "error",
                      }),
                    )
                  }
                />
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      )}
    </section>
  );
}
