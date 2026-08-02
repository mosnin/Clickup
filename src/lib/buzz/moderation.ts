// Moderation's vocabulary, and the triage math over it.
//
// Pure — no Convex, no React, no ctx — and imported by **both** sides, the way
// `notify.ts` is imported by `convex/buzz/notifications.ts` rather than copied
// into it. The reason is the same one that file gives and it is sharper here:
// a moderation queue whose severity ranking or whose action/status pairing
// disagreed between the screen and the server would not fail loudly. It would
// silently put the wrong report at the top, or record a decision whose stored
// status contradicts the action it names — and nobody finds that until they are
// reading an audit trail during an incident.
//
// What lives here: the closed vocabulary (report types, statuses, actions,
// timeout presets), the triage fold (group, rank, order), and the timeout
// rejection parse contract. What deliberately does not: anything about *who*
// may moderate, which is `channels.mayGovernCommunity`, and anything about what
// a moderator may see, which is the visibility gate in `convex/buzz/moderation.ts`.
// Authority and visibility are server questions; a pure module that answered
// either would be a rule a client could skip.
//
// Spec: docs/buzz-parity/03-workflows-projects.md §6.

// ---------------------------------------------------------------------------
// The vocabulary (§6.1, §6.2)
// ---------------------------------------------------------------------------

/**
 * NIP-56 report categories, in the order they are offered.
 *
 * `other` is last so it reads as the fallback rather than as a first option —
 * a category list whose escape hatch is in the middle gets picked out of
 * fatigue, and every report filed under it is a report a moderator has to read
 * in full to triage.
 */
export const REPORT_TYPES = [
  "spam",
  "profanity",
  "nudity",
  "impersonation",
  "malware",
  "illegal",
  "other",
] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

/** The label each category is offered under. */
export const REPORT_TYPE_LABELS: Record<ReportType, string> = {
  spam: "Spam",
  profanity: "Profanity or hate speech",
  nudity: "Nudity or sexual content",
  impersonation: "Impersonation",
  malware: "Malware or a scam",
  illegal: "Illegal content",
  other: "Something else",
};

/**
 * Triage severity (§6.4).
 *
 * `illegal` tops the queue because it routes out of community discretion into
 * the platform-safety lane — it is the one category whose right answer is "this
 * is not yours to decide", so it must never sit under a pile of spam waiting
 * for somebody to scroll.
 */
export const SEVERITY_RANK: Record<ReportType, number> = {
  illegal: 6,
  malware: 5,
  impersonation: 4,
  nudity: 3,
  spam: 2,
  profanity: 1,
  other: 0,
};

/** Unknown categories rank at the bottom rather than crashing the sort. */
export function severityOf(reportType: string): number {
  return SEVERITY_RANK[reportType as ReportType] ?? 0;
}

export const REPORT_STATUSES = ["open", "resolved", "dismissed", "escalated"] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

/**
 * What resolving a report did. `open` is the default and the only actionable
 * state; `escalated` routes out of community discretion.
 */
export const RESOLUTION_ACTIONS = [
  "delete",
  "kick",
  "ban",
  "timeout",
  "dismiss",
  "escalate",
] as const;
export type ResolutionAction = (typeof RESOLUTION_ACTIONS)[number];

/**
 * The actions the queue will actually carry out.
 *
 * `timeout` and `kick` are in the vocabulary because the wire format has them
 * and are not offered here, for two different reasons — see
 * `convex/buzz/moderation.ts:resolveReport`, which refuses them with those
 * reasons rather than ignoring them. A control that produces a stub is worse
 * than a control that is absent, so the screen offers exactly this list.
 */
export const QUEUE_ACTIONS: readonly ResolutionAction[] = [
  "delete",
  "ban",
  "dismiss",
  "escalate",
];

export const RESOLUTION_ACTION_LABELS: Record<ResolutionAction, string> = {
  delete: "Remove the message",
  kick: "Remove from the room",
  ban: "Ban the author",
  timeout: "Time the author out",
  dismiss: "Dismiss",
  escalate: "Escalate",
};

/**
 * The command's own status, paired with its action.
 *
 * The pairing `(action === "dismiss") === (status === "dismissed")` is enforced
 * server-side, so it is derived here rather than offered as a second control: a
 * client that could send the two independently could send a combination the
 * server must reject, which is a validation error standing in for a choice
 * nobody should have been given.
 */
export function statusForAction(action: ResolutionAction): "resolved" | "dismissed" {
  return action === "dismiss" ? "dismissed" : "resolved";
}

/** Where the *report row* lands. Escalation is a lane, not just a resolution. */
export function reportStatusForAction(action: ResolutionAction): ReportStatus {
  if (action === "escalate") return "escalated";
  return statusForAction(action);
}

/** §6.2: shared by the queue and the per-message menu so the two cannot drift. */
export const TIMEOUT_PRESETS: readonly { label: string; seconds: number }[] = [
  { label: "1 hour", seconds: 60 * 60 },
  { label: "24 hours", seconds: 24 * 60 * 60 },
  { label: "7 days", seconds: 7 * 24 * 60 * 60 },
];

// ---------------------------------------------------------------------------
// The rows, as the screen reads them
// ---------------------------------------------------------------------------

export type ReportTargetKind = "event" | "pubkey" | "blob";

/**
 * One report, as the queue receives it.
 *
 * `preview` and `targetName` are **optional by design, not by accident**: they
 * are present only when the reading moderator could have read the reported
 * event anyway. The server withholds an unreachable report entirely rather than
 * sending a redacted one, so a row that arrives with no preview is a row whose
 * message was removed — not one that was censored on the way out.
 */
export type ModerationReport = {
  id: string;
  reporterPubkey: string;
  reporterName: string;
  targetKind: ReportTargetKind;
  target: string;
  channelId?: string;
  reportType: string;
  note?: string;
  status: string;
  createdAt: number;
  resolvedAt?: number;
  resolvedByPubkey?: string;
  targetPubkey?: string;
  targetName?: string;
  preview?: string;
  removed?: boolean;
};

export type ModerationAction = {
  id: string;
  actorPubkey: string;
  actorName: string;
  action: string;
  targetPubkey?: string;
  targetName?: string;
  targetEventId?: string;
  channelId?: string;
  publicReason?: string;
  privateReason?: string;
  reportId?: string;
  createdAt: number;
};

export type CommunityRestriction = {
  pubkey: string;
  name: string;
  banned: boolean;
  timedOut: boolean;
  expiresAt?: number;
  reason?: string;
  actorPubkey: string;
  updatedAt: number;
};

// ---------------------------------------------------------------------------
// Triage (§6.4)
// ---------------------------------------------------------------------------

/**
 * The queue's group key: **kind-qualified**.
 *
 * An event id and a pubkey are both 64 lowercase hex characters. Keying on the
 * value alone would let a report about a message and a report about a person
 * collapse into one group the first time those strings collided — and the group
 * carries a channel and a set of prior actions, so the collision would
 * attribute one target's history to another's.
 */
export function targetKey(targetKind: string, target: string): string {
  return `${targetKind}:${target}`;
}

export type ModerationQueueGroup = {
  key: string;
  targetKind: ReportTargetKind;
  target: string;
  /**
   * From the first report in the group. An event target lives in exactly one
   * channel, so "the first" is "the only"; pubkey and blob targets are not
   * channel-scoped and carry none.
   */
  channelId?: string;
  /** Newest first. */
  reports: ModerationReport[];
  maxSeverity: number;
  latestCreatedAt: number;
  /**
   * Prior acts against this target, newest first. Blob groups surface none
   * **by design, not omission**: an audit row records an act against a person
   * or an event, and a blob is neither — there is nothing to correlate on, and
   * a group that showed an empty list would read as "this has never been
   * actioned" rather than "this cannot be".
   */
  priorActions: ModerationAction[];
};

/**
 * Does this audit row bear on this group?
 *
 * Event targets match on the event id; pubkey targets on the pubkey. Not both:
 * an act against the author of a reported message is a fact about the *person*,
 * and folding it into the message's group would show the same ban under every
 * message they ever wrote.
 */
export function actionMatchesTarget(
  action: ModerationAction,
  targetKind: string,
  target: string,
): boolean {
  if (targetKind === "event") return action.targetEventId === target;
  if (targetKind === "pubkey") return action.targetPubkey === target;
  return false;
}

/**
 * Reports → the groups a moderator triages.
 *
 * **The order is total and therefore stable.** Groups sort by severity
 * descending, then by most recent report descending, then by key — and that
 * last tiebreak is the one that matters: reports arrive in bursts, so two
 * groups sharing a severity *and* a millisecond are ordinary, and without a
 * final tiebreak the queue reshuffles between two reads of unchanged data,
 * under a moderator who is halfway through deciding something. The same
 * argument applies inside a group, where reports tie on `createdAt` and break
 * on `id`.
 *
 * Order-independent by construction: grouping is a map keyed on the target and
 * every list is sorted before it is returned, so the same reports in any input
 * order produce byte-identical output. The test asserts exactly that, because
 * an order-dependent implementation passes a single-order test perfectly.
 */
export function groupReports(
  reports: readonly ModerationReport[],
  actions: readonly ModerationAction[] = [],
): ModerationQueueGroup[] {
  const groups = new Map<string, ModerationQueueGroup>();

  for (const report of reports) {
    const key = targetKey(report.targetKind, report.target);
    const existing = groups.get(key);
    if (existing) {
      existing.reports.push(report);
      continue;
    }
    groups.set(key, {
      key,
      targetKind: report.targetKind,
      target: report.target,
      reports: [report],
      maxSeverity: 0,
      latestCreatedAt: 0,
      priorActions: [],
    });
  }

  const out: ModerationQueueGroup[] = [];
  for (const group of groups.values()) {
    group.reports.sort(
      (a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id),
    );
    // Taken from the newest report rather than from whichever arrived first:
    // an event's channel cannot change, so the two agree, and reading it off a
    // sorted list means the field does not depend on input order either.
    const withChannel = group.reports.find((r) => r.channelId !== undefined);
    if (withChannel?.channelId !== undefined) group.channelId = withChannel.channelId;
    group.maxSeverity = group.reports.reduce(
      (max, r) => Math.max(max, severityOf(r.reportType)),
      0,
    );
    group.latestCreatedAt = group.reports[0].createdAt;
    group.priorActions = actions
      .filter((action) => actionMatchesTarget(action, group.targetKind, group.target))
      .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
    out.push(group);
  }

  return out.sort(
    (a, b) =>
      b.maxSeverity - a.maxSeverity ||
      b.latestCreatedAt - a.latestCreatedAt ||
      a.key.localeCompare(b.key),
  );
}

/** Only `open` is actionable (§6.4). */
export function isActionable(report: Pick<ModerationReport, "status">): boolean {
  return report.status === "open";
}

// ---------------------------------------------------------------------------
// The timeout parse contract (§6.3)
// ---------------------------------------------------------------------------

/**
 * The prefix that identifies a send rejection as a timeout.
 *
 * **Load bearing.** There is deliberately no proactive "am I restricted" read —
 * v1 is reactive — so this string is the only channel by which a composer
 * learns it is timed out. It is written once here and produced once by
 * `convex/buzz/moderation.ts:timeoutRejection`; if the two ever drift the
 * banner silently stops appearing, which presents to a person as messages that
 * vanish with no explanation, which is the shadow-ban this design exists to
 * refuse.
 */
export const TIMEOUT_REJECTION_PREFIX = "restricted: you are timed out until";

export type TimeoutRejection = {
  /** Milliseconds, for the countdown. `null` when the timestamp is unreadable. */
  expiresAtMs: number | null;
};

/**
 * Read a send rejection as a timeout, or `null` if it is not one.
 *
 * The prefix identifies it; the timestamp is **best effort**. An unparseable
 * timestamp yields `expiresAtMs: null`, and `isTimeoutActive` treats that as
 * still active — **fail closed**. The alternative fails open: a composer that
 * re-enables itself because it could not read a number would let somebody type
 * a message that is then refused again, which teaches them the product is
 * broken rather than that they are timed out.
 */
export function parseTimeoutRejection(message: string): TimeoutRejection | null {
  const text = message.trim();
  if (!text.startsWith(TIMEOUT_REJECTION_PREFIX)) return null;
  const tail = text.slice(TIMEOUT_REJECTION_PREFIX.length).trim();
  const seconds = Number.parseInt(tail, 10);
  if (!Number.isFinite(seconds) || seconds <= 0) return { expiresAtMs: null };
  return { expiresAtMs: seconds * 1000 };
}

/** Fail closed: an unreadable expiry is still a timeout. */
export function isTimeoutActive(
  rejection: TimeoutRejection | null,
  nowMs: number,
): boolean {
  if (!rejection) return false;
  if (rejection.expiresAtMs === null) return true;
  return rejection.expiresAtMs > nowMs;
}

/**
 * "2h 5m" / "3m 20s" / "12s" — two units at most.
 *
 * Two because a countdown is read at a glance and "2h 5m 41s" changes every
 * second in a place the eye is not looking. Never negative: a countdown that
 * has run out reads "0s" while the next send proves it, rather than counting
 * upwards into a number nobody can interpret.
 */
export function formatTimeoutRemaining(remainingMs: number): string {
  const total = Math.max(0, Math.floor(remainingMs / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes > 0) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  return `${seconds}s`;
}

/** The banner's sentence. One writer, so the copy cannot drift per surface. */
export function timeoutBannerText(remainingMs: number | null): string {
  return remainingMs === null
    ? "You're timed out by community moderators."
    : `You're timed out by community moderators — ${formatTimeoutRemaining(remainingMs)} left.`;
}
