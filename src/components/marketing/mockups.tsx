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
          <span className="ml-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
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
    <MockShell label="Agents · live" className={className}>
      <div className="p-3.5">
        <div className="flex items-center gap-2.5">
          <span className="text-xl" aria-hidden>
            🤖
          </span>
          <div className="min-w-0">
            <p className="text-[13px] font-semibold leading-tight">Scout</p>
            <p className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-emerald-600">
              <span className="relative inline-flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500/60" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
              </span>
              Online
            </p>
          </div>
          <span className="ml-auto rounded-full bg-muted px-2 py-0.5 text-[9px] uppercase tracking-wider text-muted-foreground">
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
  { title: "Ship weekly digest email", chip: "🤖 Scout", chipBg: "bg-pastel-blue" },
  { title: "QA the onboarding flow", chip: "Sprint 12", chipBg: "bg-pastel-purple" },
  { title: "Refresh pricing page copy", chip: "Due Fri", chipBg: "bg-pastel-yellow" },
];

export function TaskListMock({ className }: { className?: string }) {
  const phase = useCycle(2, 2400); // 0 = open, 1 = done
  const done = phase === 1;
  return (
    <MockShell label="Launch week · list" className={className}>
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
  { actor: "🤖 Scout", verb: "completed task", entity: "Draft release notes" },
  { actor: "Maya", verb: "approved", entity: "Send pricing email" },
  { actor: "🤖 Atlas", verb: "claimed task", entity: "Fix flaky test" },
  { actor: "🤖 Scout", verb: "commented on", entity: "Q3 launch plan" },
  { actor: "Maya", verb: "started sprint", entity: "Sprint 12" },
];

export function ActivityFeedMock({ className }: { className?: string }) {
  const i = useCycle(FEED.length, 2200);
  const visible = [0, 1, 2].map((o) => FEED[(i + FEED.length - o) % FEED.length]);
  return (
    <MockShell label="Activity · everything, live" className={className}>
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
            ? "Approved — Scout may complete this."
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
            <p className="px-1 pb-1 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
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
                    🤖 Atlas
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
        "overflow-hidden rounded-2xl border border-white/10 bg-moss-950 font-mono text-[11px] text-sage-200 shadow-[0_24px_60px_-24px_rgb(0_0_0/0.6)]",
        className,
      )}
    >
      <div className="flex items-center gap-1.5 border-b border-white/10 px-3.5 py-2">
        <span className="h-1.5 w-1.5 rounded-full bg-white/20" />
        <span className="h-1.5 w-1.5 rounded-full bg-white/20" />
        <span className="ml-1.5 text-[10px] uppercase tracking-[0.14em] text-white/40">
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
          <span className="font-semibold">🤖 Atlas</span>
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
