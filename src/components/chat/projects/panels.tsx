"use client";

// The pieces every project surface is made of.
//
// Three surfaces draw the same four things — a verdict, a branch, a patch, a
// feed — and they are here rather than in each screen because a status chip that
// says "Approved" on the project page and "approved" in the room is two
// vocabularies on one product. The words themselves come from
// `describeStatus`/`describeBranchState` in `src/lib/buzz/project.ts`, so the
// copy has one home and this file only decides how it is drawn.
//
// Brand rules, applied rather than restated: surfaces are `.panel` (the
// soft-shadow bento card) and wells are `.bento-tile`, never a hand-rolled
// `border border-border`; there are **no decorative icons** — every glyph below
// is either a link/button affordance or a semantic state indicator; chips are
// `rounded-full`; small hit areas carry `.tap-target`. Meaning is carried by the
// pastel tokens, and green stays reserved for the positive reading.

import Link from "next/link";
import { GitBranch, GitMerge } from "lucide-react";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/time";
import { truncatePubkey, type TimelineActor } from "@/lib/buzz/timeline";
import {
  describeBranchState,
  describeStatus,
  shortCommit,
  type ActivityItem,
  type BranchRoom,
  type BranchState,
  type ForgePatch,
  type StatusOutcome,
} from "@/lib/buzz/project";

/** Nostr `created_at` is seconds; `timeAgo` speaks this app's milliseconds. */
export function agoOf(seconds: number): string {
  return seconds > 0 ? timeAgo(seconds * 1000) : "";
}

/** A person, however far the profile batch got. Never a bare 64-hex string. */
export function labelOf(
  actors: ReadonlyMap<string, TimelineActor> | undefined,
  pubkey: string,
): string {
  return actors?.get(pubkey)?.label?.trim() || truncatePubkey(pubkey);
}

/**
 * How a verdict is coloured.
 *
 * Pastel tokens with dark ink on top, which is the brand rule, and the mapping
 * is by *meaning* rather than by kind: a failed check and a closed branch read
 * the same because they mean the same thing to somebody scanning a list — this
 * one is not going anywhere right now.
 */
const OUTCOME_TONE: Record<StatusOutcome, string> = {
  open: "bg-pastel-blue",
  draft: "bg-pastel-yellow",
  closed: "bg-pastel-red",
  merged: "bg-pastel-purple",
  passed: "bg-pastel-green",
  failed: "bg-pastel-red",
  running: "bg-pastel-yellow",
  approved: "bg-pastel-green",
  changes_requested: "bg-pastel-yellow",
};

export function StatusChip({
  outcome,
  label,
  className,
}: {
  outcome: StatusOutcome;
  /** Overrides the shared copy. Used only where the row already says the noun. */
  label?: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[0.6875rem] font-medium text-foreground",
        OUTCOME_TONE[outcome],
        className,
      )}
    >
      {label ?? describeStatus(outcome)}
    </span>
  );
}

export function BranchStateChip({ state }: { state: BranchState }) {
  return <StatusChip outcome={state} label={describeBranchState(state)} />;
}

/**
 * One branch room as a row.
 *
 * The row is a link into the room, and that is the whole navigation model: a
 * branch is not a detail page beside the conversation, it *is* the conversation.
 * Everything the row shows — the verdicts, the tip, who is on it — is a summary
 * of what is inside, so following it never loses context.
 */
export function BranchRow({
  room,
  href,
  actors,
}: {
  room: BranchRoom;
  href: string;
  actors?: ReadonlyMap<string, TimelineActor>;
}) {
  const binding = room.binding;
  const approvals = room.reviews.filter((r) => r.outcome === "approved" && r.current).length;
  const changes = room.reviews.filter(
    (r) => r.outcome === "changes_requested" && r.current,
  ).length;

  return (
    <Link
      href={href}
      className="panel lift block rounded-2xl p-4 no-underline"
    >
      <div className="flex items-start gap-2">
        <GitBranch aria-hidden className="chat-quiet mt-0.5 size-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">
            {binding ? binding.title || binding.branch : "Unbound room"}
          </p>
          <p className="chat-quiet mt-0.5 truncate text-xs">
            {binding ? (
              <>
                {binding.branch}
                {binding.targetBranch ? ` → ${binding.targetBranch}` : ""}
                {room.tip ? ` · ${shortCommit(room.tip)}` : ""}
              </>
            ) : (
              "No branch bound to this room yet"
            )}
          </p>
        </div>
        <BranchStateChip state={room.state} />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {room.check ? <StatusChip outcome={room.check.outcome} /> : null}
        {approvals > 0 ? (
          <StatusChip
            outcome="approved"
            label={approvals === 1 ? "1 approval" : `${approvals} approvals`}
          />
        ) : null}
        {changes > 0 ? <StatusChip outcome="changes_requested" /> : null}
        <span className="chat-quiet ml-auto shrink-0 text-[0.6875rem]">
          {room.patches.length === 1 ? "1 patch" : `${room.patches.length} patches`}
          {room.lastActivityAt > 0 ? ` · ${agoOf(room.lastActivityAt)}` : ""}
        </span>
      </div>

      {room.merge ? (
        <p className="chat-quiet mt-2 flex items-center gap-1.5 text-xs">
          <GitMerge aria-hidden className="size-3.5 shrink-0" />
          Merged by {labelOf(actors, room.merge.by)}
          {room.merge.mergeCommit ? ` as ${shortCommit(room.merge.mergeCommit)}` : ""}
        </p>
      ) : null}
    </Link>
  );
}

/**
 * A patch, drawn as a diff.
 *
 * Monospace, pre-wrapped, and **never markdown**: the content of a 1617 is
 * `git format-patch` output, where a leading `#` is a comment and a leading `+`
 * is an added line. Rendering it through the message renderer would turn a diff
 * into headings and lists — the body would still be in the log and the reader
 * would be looking at something else.
 *
 * Collapsed past a few lines, because a branch room's panel is a summary of a
 * branch and a full patch is a file.
 */
export function PatchBlock({
  patch,
  actors,
  expanded,
  onToggle,
}: {
  patch: ForgePatch;
  actors?: ReadonlyMap<string, TimelineActor>;
  expanded: boolean;
  onToggle: () => void;
}) {
  const lines = patch.body.split("\n");
  const shown = expanded ? lines : lines.slice(0, 8);

  return (
    <article className="panel rounded-2xl p-4">
      <header className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h4 className="truncate text-sm font-semibold">
            {patch.title || shortCommit(patch.commit) || "Patch"}
          </h4>
          <p className="chat-quiet mt-0.5 truncate text-xs">
            {labelOf(actors, patch.by)}
            {patch.commit ? ` · ${shortCommit(patch.commit)}` : ""}
            {patch.at > 0 ? ` · ${agoOf(patch.at)}` : ""}
          </p>
        </div>
      </header>
      <pre className="bento-tile mt-3 overflow-x-auto rounded-xl p-3 text-[0.6875rem] leading-relaxed">
        <code className="font-mono">{shown.join("\n")}</code>
      </pre>
      {lines.length > 8 ? (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="chat-quiet tap-target mt-2 text-xs font-medium underline underline-offset-2"
        >
          {expanded ? "Show less" : `Show all ${lines.length} lines`}
        </button>
      ) : null}
    </article>
  );
}

/**
 * The activity feed: verb, object, outcome (§3.2).
 *
 * Every row is derived from something already on the screen, and nothing is
 * stored — a feed with its own store is a feed that can disagree with the thing
 * it summarises.
 */
export function ActivityFeed({
  items,
  actors,
  hrefFor,
}: {
  items: readonly ActivityItem[];
  actors?: ReadonlyMap<string, TimelineActor>;
  hrefFor: (channelId: string) => string;
}) {
  if (items.length === 0) {
    return <p className="chat-quiet text-sm">Nothing has happened here yet.</p>;
  }
  return (
    <ul className="space-y-1">
      {items.map((item) => (
        <li key={item.id}>
          <Link
            href={hrefFor(item.channelId)}
            className="chat-row block no-underline"
          >
            <span className="min-w-0 flex-1 truncate text-sm">
              <span className="font-medium">{labelOf(actors, item.by)}</span>{" "}
              {item.verb}
              {item.detail ? ` ${item.detail}` : ""}
            </span>
            <span className="chat-quiet shrink-0 text-[0.6875rem]">{agoOf(item.at)}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** A run of counts. The overview's stat band, with no glyphs on it. */
export function StatPills({ stats }: { stats: readonly [string, string][] }) {
  return (
    <dl className="flex flex-wrap gap-2">
      {stats.map(([label, value]) => (
        <div key={label} className="panel rounded-2xl px-4 py-3">
          <dt className="chat-quiet text-[0.6875rem] uppercase tracking-wider">{label}</dt>
          <dd className="mt-0.5 text-lg font-semibold tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The one empty state shape these screens use. No centred glyph — brand rule. */
export function EmptyNote({ title, body }: { title: string; body: string }) {
  return (
    <div className="panel rounded-2xl p-6">
      <p className="text-sm font-semibold">{title}</p>
      <p className="chat-quiet mt-1 text-sm">{body}</p>
    </div>
  );
}
