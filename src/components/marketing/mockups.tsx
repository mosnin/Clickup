"use client";

// Animated product illustrations for the marketing site — miniature,
// looping recreations of real app surfaces (agent cards, task rows,
// approvals, board moves, the activity feed) built in HTML/CSS so they
// stay razor sharp at any size. All loops run off useCycle, which
// freezes under prefers-reduced-motion.

import { Check, Lock, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import { AnimatePresence, EASE, motion, SPRING } from "@/components/motion";
import { useCycle } from "@/components/marketing/reveal";

// White-sheet card chrome shared by every mock.
export function MockShell({
  label,
  children,
  className,
}: {
  label?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-2xl border border-black/5 bg-white text-left text-foreground shadow-[0_24px_60px_-24px_rgb(16_16_18/0.35)]",
        className,
      )}
    >
      {label && (
        <div className="flex items-center gap-1.5 border-b border-border px-3.5 py-2">
          <span className="h-1.5 w-1.5 rounded-full bg-black/10" />
          <span className="h-1.5 w-1.5 rounded-full bg-black/10" />
          <span className="ml-1.5 text-[11px] font-medium text-muted-foreground">
            {label}
          </span>
        </div>
      )}
      {children}
    </div>
  );
}

// ── Agent presence card: heartbeat dot + cycling "Now: …" line ─────────
const AGENT_STATUS = [
  "Drafting the release notes",
  "Reviewing PR #142",
  "Triaging 6 new tickets",
  "Waiting on your approval",
];

export function AgentCardMock({ className }: { className?: string }) {
  const i = useCycle(AGENT_STATUS.length, 3000);
  return (
    <MockShell label="Agents, live" className={className}>
      <div className="p-3.5">
        <div className="flex items-center gap-2.5">
          <span
            aria-hidden
            className="inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-ember-100 text-sm font-semibold text-ember-700"
          >
            S
          </span>
          <div className="min-w-0">
            <p className="text-[13px] font-semibold leading-tight">Scout</p>
            <p className="flex items-center gap-1 text-[10px] font-medium text-emerald-700">
              <span className="relative inline-flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500/60" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
              </span>
              Online
            </p>
          </div>
          <span className="ml-auto rounded-full bg-black/[0.05] px-2 py-0.5 text-[10px] font-medium text-foreground/55">
            Member
          </span>
        </div>
        <div className="mt-2.5 overflow-hidden rounded-xl bg-muted/60 px-3 py-1.5 text-xs">
          <span className="font-semibold">Now: </span>
          <span className="relative inline-block h-4 overflow-hidden align-bottom">
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span
                key={i}
                initial={{ y: 12, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                exit={{ y: -12, opacity: 0 }}
                transition={{ duration: 0.4, ease: EASE }}
                className="inline-block whitespace-nowrap"
              >
                {AGENT_STATUS[i]}
              </motion.span>
            </AnimatePresence>
          </span>
        </div>
      </div>
    </MockShell>
  );
}

// ── Task rows: the top task checks itself off on a loop ────────────────
const TASK_ROWS = [
  { title: "Ship weekly digest email", chip: "Scout", chipBg: "bg-ember-100 text-ember-700" },
  { title: "QA the onboarding flow", chip: "Sprint 12", chipBg: "bg-black/[0.05] text-foreground/60" },
  { title: "Refresh pricing page copy", chip: "Due Fri", chipBg: "bg-black/[0.05] text-foreground/60" },
];

export function TaskListMock({ className }: { className?: string }) {
  const phase = useCycle(2, 2400); // 0 = open, 1 = done
  const done = phase === 1;
  return (
    <MockShell label="Launch week, list" className={className}>
      <ul className="divide-y divide-border">
        {TASK_ROWS.map((t, idx) => {
          const isDone = idx === 0 && done;
          return (
            <li key={t.title} className="flex items-center gap-2.5 px-3.5 py-2">
              <span
                className={cn(
                  "inline-flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full border-2 transition-colors duration-300",
                  isDone
                    ? "border-emerald-500 bg-emerald-500 text-white"
                    : "border-black/15 text-transparent",
                )}
              >
                <motion.span
                  initial={false}
                  animate={{ scale: isDone ? 1 : 0 }}
                  transition={{ type: "spring", stiffness: 500, damping: 22 }}
                  className="inline-flex"
                >
                  <Check className="h-2.5 w-2.5" strokeWidth={4} />
                </motion.span>
              </span>
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-xs transition-colors duration-300",
                  isDone && "text-muted-foreground line-through",
                )}
              >
                {t.title}
              </span>
              <span
                className={cn(
                  "flex-shrink-0 rounded-full px-2 py-0.5 text-[9px] font-medium",
                  t.chipBg,
                )}
              >
                {t.chip}
              </span>
            </li>
          );
        })}
      </ul>
    </MockShell>
  );
}

// ── Activity feed: events slide in on a loop ───────────────────────────
const FEED = [
  { actor: "Scout", verb: "completed task", entity: "Draft release notes" },
  { actor: "Maya", verb: "approved", entity: "Send pricing email" },
  { actor: "Atlas", verb: "claimed task", entity: "Fix flaky test" },
  { actor: "Scout", verb: "commented on", entity: "Q3 launch plan" },
  { actor: "Maya", verb: "started sprint", entity: "Sprint 12" },
];

export function ActivityFeedMock({ className }: { className?: string }) {
  const i = useCycle(FEED.length, 2200);
  const visible = [0, 1, 2].map((o) => FEED[(i + FEED.length - o) % FEED.length]);
  return (
    <MockShell label="Activity, live" className={className}>
      <ul className="space-y-1.5 p-3">
        <AnimatePresence initial={false} mode="popLayout">
          {visible.map((e) => (
            <motion.li
              key={`${e.actor}-${e.entity}`}
              layout
              initial={{ opacity: 0, y: -14, filter: "blur(3px)" }}
              animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
              exit={{ opacity: 0, y: 10 }}
              transition={{ duration: 0.45, ease: EASE }}
              className="flex items-baseline gap-1.5 rounded-xl border border-border bg-white px-2.5 py-1.5 text-[11px]"
            >
              <span className="flex-shrink-0 rounded-full bg-muted px-1.5 py-px text-[9px] font-medium">
                {e.actor}
              </span>
              <span className="truncate text-muted-foreground">
                {e.verb} <span className="font-medium text-foreground">{e.entity}</span>
              </span>
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
    </MockShell>
  );
}

// ── Approval gate: the human-in-the-loop moment ────────────────────────
export function ApprovalMock({ className }: { className?: string }) {
  const phase = useCycle(2, 3200); // 0 = waiting, 1 = approved
  const approved = phase === 1;
  return (
    <MockShell label="Approval gate" className={className}>
      <div className="space-y-2.5 p-3.5">
        <p className="text-[13px] font-semibold leading-snug">
          Send invoice batch to 240 clients
        </p>
        <div
          className={cn(
            "flex items-center gap-2 rounded-xl border px-2.5 py-1.5 text-[11px] transition-colors duration-500",
            approved
              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
              : "border-amber-200 bg-amber-50 text-amber-800",
          )}
        >
          {approved ? (
            <ShieldCheck className="h-3.5 w-3.5 flex-shrink-0" />
          ) : (
            <Lock className="h-3.5 w-3.5 flex-shrink-0" />
          )}
          {approved
            ? "Approved. Scout may complete this."
            : "Agent is waiting for a human."}
        </div>
        <motion.span
          animate={{ scale: approved ? [1, 0.94, 1] : 1 }}
          transition={{ duration: 0.4, ease: EASE }}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[11px] font-semibold transition-colors duration-300",
            approved
              ? "bg-emerald-600 text-white"
              : "bg-foreground text-white",
          )}
        >
          {approved && <Check className="h-3 w-3" strokeWidth={3} />}
          {approved ? "Approved" : "Approve"}
        </motion.span>
      </div>
    </MockShell>
  );
}

// ── Kanban: a card hops columns on a loop ──────────────────────────────
const BOARD_COLS = ["To do", "In progress", "Done"];

export function BoardMock({ className }: { className?: string }) {
  const pos = useCycle(3, 2400);
  return (
    <MockShell label="Board" className={className}>
      <div className="grid grid-cols-3 gap-2 p-3">
        {BOARD_COLS.map((col, ci) => (
          <div key={col} className="rounded-xl bg-muted/50 p-1.5">
            <p className="px-1 pb-1 text-[10px] font-medium text-muted-foreground">
              {col}
            </p>
            <div className="space-y-1.5">
              {ci === 0 && (
                <div className="h-7 rounded-lg border border-border bg-white" />
              )}
              {ci === pos && (
                <motion.div
                  layoutId="board-mock-card"
                  transition={SPRING}
                  className="rounded-lg border border-border bg-white p-1.5"
                >
                  <p className="truncate text-[10px] font-medium">
                    Migrate billing cron
                  </p>
                  <p className="mt-0.5 text-[9px] text-muted-foreground">
                    Atlas
                  </p>
                </motion.div>
              )}
              {ci === 1 && (
                <div className="h-7 rounded-lg border border-border bg-white" />
              )}
            </div>
          </div>
        ))}
      </div>
    </MockShell>
  );
}

// ── Connect: the two-line MCP setup, "typed" line by line ──────────────
const CONNECT_LINES = [
  { text: "$ url  https://yourteam.app/api/mcp", dim: false },
  { text: "$ auth Bearer cua_9f2…d41", dim: false },
  { text: "→ whoami · Scout (member)", dim: true },
  { text: "→ heartbeat · online ●", dim: true },
];

export function ConnectMock({ className }: { className?: string }) {
  const step = useCycle(CONNECT_LINES.length + 1, 1400);
  return (
    <div
      className={cn(
        "overflow-hidden rounded-2xl border border-white/10 bg-cocoa-950 font-mono text-[11px] text-ember-200 shadow-[0_24px_60px_-24px_rgb(0_0_0/0.6)]",
        className,
      )}
    >
      <div className="flex items-center gap-1.5 border-b border-white/10 px-3.5 py-2">
        <span className="h-1.5 w-1.5 rounded-full bg-white/20" />
        <span className="h-1.5 w-1.5 rounded-full bg-white/20" />
        <span className="ml-1.5 text-[11px] font-medium text-white/40">
          any MCP runtime
        </span>
      </div>
      <div className="space-y-1.5 p-3.5">
        {CONNECT_LINES.map((line, i) => (
          <motion.p
            key={line.text}
            initial={false}
            animate={{ opacity: step > i ? 1 : 0.12 }}
            transition={{ duration: 0.5, ease: EASE }}
            className={cn("whitespace-nowrap", line.dim && "text-emerald-400/90")}
          >
            {line.text}
          </motion.p>
        ))}
      </div>
    </div>
  );
}

// ── Budget meter: governance made visible ──────────────────────────────
export function BudgetMock({ className }: { className?: string }) {
  const phase = useCycle(4, 1800);
  const pct = [24, 47, 71, 90][phase];
  return (
    <MockShell label="Daily action budget" className={className}>
      <div className="space-y-2 p-3.5">
        <div className="flex items-baseline justify-between text-[11px]">
          <span className="font-semibold">Atlas</span>
          <span className="tabular-nums text-muted-foreground">
            {Math.round(pct * 20)} / 2,000 actions
          </span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
          <motion.div
            animate={{ width: `${pct}%` }}
            transition={{ type: "spring", stiffness: 90, damping: 24 }}
            className={cn(
              "h-full rounded-full",
              pct > 85 ? "bg-red-500" : "bg-foreground",
            )}
          />
        </div>
        <p className="text-[10px] text-muted-foreground">
          Hard stop at the cap. 60/min burst limit on top.
        </p>
      </div>
    </MockShell>
  );
}

// ── The handoff story card ──────────────────────────────────────────────
// One task card that evolves through the five beats of the scroll story:
// 0 created → 1 claimed → 2 worked → 3 gated → 4 approved & done.
// Driven externally by `step` so the scrollytelling section owns pacing.

const HANDOFF_CHECKLIST = [
  "Pull last quarter's numbers",
  "Draft with 3 subject lines",
  "Link the doc on this task",
];

export function HandoffMock({ step, className }: { step: number; className?: string }) {
  const done = step >= 4;
  return (
    <MockShell label="Task, live" className={className}>
      <div className="space-y-3 p-4 sm:p-5">
        {/* Title row */}
        <div className="flex items-start gap-2.5">
          <span
            className={cn(
              "mt-0.5 inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full border-2 transition-colors duration-500",
              done
                ? "border-emerald-500 bg-emerald-500 text-white"
                : "border-black/15 text-transparent",
            )}
          >
            <motion.span
              initial={false}
              animate={{ scale: done ? 1 : 0 }}
              transition={{ type: "spring", stiffness: 500, damping: 22 }}
              className="inline-flex"
            >
              <Check className="h-3 w-3" strokeWidth={4} />
            </motion.span>
          </span>
          <div className="min-w-0 flex-1">
            <p
              className={cn(
                "text-sm font-semibold leading-snug transition-colors duration-500",
                done && "text-muted-foreground line-through",
              )}
            >
              Draft the Acme renewal email
            </p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              {step === 0 ? "Created by you · just now" : "Assigned · Scout"}
            </p>
          </div>
          <AnimatePresence>
            {step >= 1 && step < 4 && (
              <motion.span
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.9 }}
                transition={SPRING}
                className="inline-flex flex-shrink-0 items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700"
              >
                <span className="relative inline-flex h-1 w-1">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-500/70" />
                  <span className="relative inline-flex h-1 w-1 rounded-full bg-amber-500" />
                </span>
                Claimed
              </motion.span>
            )}
          </AnimatePresence>
        </div>

        {/* Checklist */}
        <ul className="space-y-1.5 rounded-xl bg-muted/50 p-2.5">
          {HANDOFF_CHECKLIST.map((item, i) => {
            const ticked = step >= 3 || (step >= 2 && i < 2);
            return (
              <li key={item} className="flex items-center gap-2 text-[11px]">
                <span
                  className={cn(
                    "inline-flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center rounded-full border transition-colors duration-500",
                    ticked
                      ? "border-emerald-500 bg-emerald-500 text-white"
                      : "border-black/15 bg-white text-transparent",
                  )}
                >
                  <motion.span
                    initial={false}
                    animate={{ scale: ticked ? 1 : 0 }}
                    transition={{
                      type: "spring",
                      stiffness: 500,
                      damping: 24,
                      delay: ticked ? i * 0.12 : 0,
                    }}
                    className="inline-flex"
                  >
                    <Check className="h-2 w-2" strokeWidth={4} />
                  </motion.span>
                </span>
                <span
                  className={cn(
                    "transition-colors duration-500",
                    ticked && "text-muted-foreground line-through",
                  )}
                >
                  {item}
                </span>
              </li>
            );
          })}
        </ul>

        {/* Narration comment */}
        <AnimatePresence>
          {step >= 2 && (
            <motion.div
              initial={{ opacity: 0, y: 10, filter: "blur(3px)" }}
              animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.45, ease: EASE }}
              className="flex items-start gap-2"
            >
              <span
                aria-hidden
                className="mt-0.5 inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-foreground text-[9px] font-semibold text-white"
              >
                S
              </span>
              <p className="min-w-0 flex-1 rounded-xl rounded-tl-md border border-border bg-white px-2.5 py-1.5 text-[11px] leading-snug">
                {step >= 4
                  ? "Sent. Doc + thread linked below."
                  : "Went with subject line B, numbers are in the linked doc."}
              </p>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Approval gate / receipt */}
        <AnimatePresence mode="wait">
          {step === 3 && (
            <motion.div
              key="gate"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.4, ease: EASE }}
              className="flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800"
            >
              <Lock className="h-3.5 w-3.5 flex-shrink-0" />
              <span className="min-w-0 flex-1">
                Sending to a client is gated, waiting for you.
              </span>
              <span className="flex-shrink-0 rounded-full bg-foreground px-3 py-1 text-[10px] font-semibold text-white">
                Approve
              </span>
            </motion.div>
          )}
          {step >= 4 && (
            <motion.div
              key="receipt"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, ease: EASE }}
              className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-[11px] text-emerald-800"
            >
              <ShieldCheck className="h-3.5 w-3.5 flex-shrink-0" />
              <span className="min-w-0 flex-1">
                Approved by you · run report: 1 doc · 8,214 tokens · $0.11
              </span>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </MockShell>
  );
}

// ── Mini illustrations for Expo-style feature cards ─────────────────────
// Small, self-explanatory product moments — these replace decorative
// icons entirely. Each floats on a warm wash inside FeatureCard.

// Four views: a pill tab row over tiny gantt bars.
export function ViewsMock({ className }: { className?: string }) {
  const active = useCycle(4, 2000);
  const tabs = ["List", "Board", "Calendar", "Gantt"];
  return (
    <div className={cn("w-full max-w-[240px] rounded-xl border border-black/5 bg-white p-3 shadow-[0_16px_40px_-20px_rgb(16_16_18/0.3)]", className)}>
      <div className="flex gap-1 rounded-full bg-muted/70 p-0.5">
        {tabs.map((t, i) => (
          <span
            key={t}
            className={cn(
              "flex-1 rounded-full py-1 text-center text-[9px] font-medium transition-colors duration-300",
              i === active ? "bg-foreground text-white" : "text-muted-foreground",
            )}
          >
            {t}
          </span>
        ))}
      </div>
      <div className="mt-3 space-y-1.5">
        {[[8, 46], [22, 58], [40, 34]].map(([left, width], i) => (
          <div key={i} className="h-2.5 rounded-full bg-muted/60">
            <motion.div
              initial={false}
              animate={{ marginLeft: `${left}%`, width: `${width}%` }}
              transition={{ type: "spring", stiffness: 120, damping: 20 }}
              className={cn(
                "h-full rounded-full",
                i === 1 ? "bg-ember-400" : "bg-foreground/20",
              )}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

// Doc with the AI writer continuing a paragraph.
export function DocAiMock({ className }: { className?: string }) {
  const phase = useCycle(2, 2600);
  return (
    <div className={cn("w-full max-w-[240px] rounded-xl border border-black/5 bg-white p-4 shadow-[0_16px_40px_-20px_rgb(16_16_18/0.3)]", className)}>
      <p className="text-[11px] font-semibold">Q3 launch plan</p>
      <div className="mt-2 space-y-1.5">
        <div className="h-1.5 w-full rounded-full bg-muted" />
        <div className="h-1.5 w-5/6 rounded-full bg-muted" />
        <motion.div
          initial={false}
          animate={{ width: phase ? "66%" : "12%" }}
          transition={{ duration: 1.6, ease: EASE }}
          className="h-1.5 rounded-full bg-ember-300"
        />
      </div>
      <span className="mt-3 inline-flex items-center gap-1 rounded-full bg-black/[0.05] px-2 py-0.5 text-[9px] font-medium text-foreground/60">
        AI continuing…
      </span>
    </div>
  );
}

// Sprint with a live progress fill.
export function SprintMiniMock({ className }: { className?: string }) {
  const phase = useCycle(3, 2000);
  const pct = [28, 56, 84][phase];
  return (
    <div className={cn("w-full max-w-[240px] rounded-xl border border-black/5 bg-white p-4 shadow-[0_16px_40px_-20px_rgb(16_16_18/0.3)]", className)}>
      <div className="flex items-baseline justify-between">
        <p className="text-[11px] font-semibold">Sprint 12</p>
        <span className="text-[9px] text-muted-foreground">Mar 4 – 18</span>
      </div>
      <div className="mt-2.5 h-2 overflow-hidden rounded-full bg-muted">
        <motion.div
          initial={false}
          animate={{ width: `${pct}%` }}
          transition={{ type: "spring", stiffness: 90, damping: 24 }}
          className="bg-warm h-full rounded-full"
        />
      </div>
      <p className="mt-2 text-[9px] text-muted-foreground">
        {Math.round(pct / 7)}/12 done · 2 agents on it
      </p>
    </div>
  );
}

// Tiny report: animated bar chart.
export function ReportMiniMock({ className }: { className?: string }) {
  const phase = useCycle(2, 2400);
  const bars = phase ? [34, 58, 44, 78, 62] : [22, 40, 30, 52, 44];
  return (
    <div className={cn("w-full max-w-[240px] rounded-xl border border-black/5 bg-white p-4 shadow-[0_16px_40px_-20px_rgb(16_16_18/0.3)]", className)}>
      <div className="flex items-baseline justify-between">
        <p className="text-[11px] font-semibold">Completed this week</p>
        <span className="text-[9px] font-medium text-positive">+38%</span>
      </div>
      <div className="mt-3 flex h-16 items-end gap-1.5">
        {bars.map((h, i) => (
          <motion.div
            key={i}
            initial={false}
            animate={{ height: `${h}%` }}
            transition={{ type: "spring", stiffness: 140, damping: 22, delay: i * 0.05 }}
            className={cn(
              "flex-1 rounded-t-md",
              i === 3 ? "bg-ember-400" : "bg-foreground/15",
            )}
          />
        ))}
      </div>
    </div>
  );
}

// Brain semantic search: query + results sliding in.
export function BrainMock({ className }: { className?: string }) {
  const phase = useCycle(2, 2800);
  return (
    <div className={cn("w-full max-w-[240px] rounded-xl border border-black/5 bg-white p-3.5 shadow-[0_16px_40px_-20px_rgb(16_16_18/0.3)]", className)}>
      <div className="flex items-center gap-1.5 rounded-full border border-black/[0.08] px-2.5 py-1.5 text-[10px] text-muted-foreground">
        <span aria-hidden>⌕</span> what did we decide on pricing?
      </div>
      <AnimatePresence initial={false}>
        {phase === 1 && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.4, ease: EASE }}
            className="mt-2 space-y-1"
          >
            {["Pricing v2, doc", "Tier limits, task"].map((r) => (
              <div key={r} className="rounded-lg bg-muted/60 px-2.5 py-1.5 text-[10px]">
                {r}
              </div>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ⌘K: two keycaps pressing, then the palette row.
export function CmdKMock({ className }: { className?: string }) {
  const phase = useCycle(2, 2200);
  return (
    <div className={cn("flex flex-col items-center gap-3", className)}>
      <div className="flex gap-2">
        {["⌘", "K"].map((k) => (
          <motion.span
            key={k}
            initial={false}
            animate={{ y: phase ? 2 : 0 }}
            transition={{ type: "spring", stiffness: 400, damping: 20 }}
            className="inline-flex h-11 w-11 items-center justify-center rounded-xl border border-black/[0.06] bg-white text-lg font-medium text-foreground/70 shadow-[0_3px_0_rgb(0_0_0/0.05),0_12px_28px_-14px_rgb(16_16_18/0.3)]"
          >
            {k}
          </motion.span>
        ))}
      </div>
      <AnimatePresence initial={false}>
        {phase === 1 && (
          <motion.div
            initial={{ opacity: 0, y: 6, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.35, ease: EASE }}
            className="w-full max-w-[220px] rounded-xl border border-black/5 bg-white px-3 py-2 text-[10px] shadow-[0_16px_40px_-20px_rgb(16_16_18/0.3)]"
          >
            <span className="text-muted-foreground">New task: </span>
            <span className="font-medium">“Fix pricing typo”</span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
