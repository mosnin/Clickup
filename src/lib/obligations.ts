// What is waiting on a person, as one list.
//
// The product accumulated four independent ways to need a human — a task
// behind an approval gate, a revision requested on someone's work, a plan
// question a person reserved for themselves, an outcome criterion somebody
// has to sign off — and each one lived on its own screen with its own words.
// Four surfaces means four habits, and a fleet running unattended for a week
// only has to be forgotten on ONE of them to stall.
//
// Two properties make this a queue rather than a fifth list.
//
// **It ages.** An obligation raised three days ago is more urgent than one
// raised a minute ago, which is the exact opposite of how every one of the
// four sources sorted (newest first, like a feed). A feed is for things you
// might read; a queue is for things you must answer, and the one at risk of
// never being answered is the oldest. So this sorts oldest-first and says how
// long each has waited, in words rather than timestamps.
//
// **It counts.** A number somebody can see without opening anything is what
// turns "I should check" into "there is nothing to check". Zero has to be
// reachable or the queue is just another inbox.

/**
 * The ways the product asks for a person.
 *
 * `handback` is the newest and behaves differently from the other four in one
 * way worth knowing: the others are a person being asked to DECIDE something,
 * while a handback is work already finished and sitting inert until somebody
 * consents to it. That is why it is the most expensive one to miss — nothing
 * is blocked waiting for thought, it is blocked waiting for a click.
 */
export type ObligationKind =
  | "approval"
  | "revision"
  | "question"
  | "outcome"
  | "handback";

export type Obligation = {
  kind: ObligationKind;
  /** Stable within its kind — the row's own id. */
  id: string;
  /** What is being asked, in the words of the thing asking. */
  title: string;
  /** Where the answer is given. */
  href: string;
  /** Which project/page/task this belongs to, for context. */
  place?: string;
  /** Who raised it, when that is knowable and useful. */
  raisedBy?: string;
  /** When it started waiting. */
  createdAt: number;
};

/** What each kind is called, and what the person is actually being asked. */
export const OBLIGATION_KIND: Record<
  ObligationKind,
  { label: string; verb: string }
> = {
  approval: { label: "Approval", verb: "waiting for you to approve" },
  revision: { label: "Revision", verb: "waiting on a change you asked for" },
  question: { label: "Decision", verb: "waiting for you to decide" },
  outcome: { label: "Sign-off", verb: "waiting for you to check the evidence" },
  handback: { label: "Finished", verb: "an agent finished this and needs your go-ahead" },
};

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * How long this has waited, in the product's voice.
 *
 * Deliberately coarse. "3d" and "2d 19h" carry the same decision — this has
 * been ignored for days — and the second spends precision on a number nobody
 * acts on differently. The buckets are the ones a person reacts to.
 */
export function waitedFor(createdAt: number, now: number): string {
  const ms = Math.max(0, now - createdAt);
  if (ms < HOUR) return "just now";
  if (ms < DAY) {
    const h = Math.floor(ms / HOUR);
    return `${h}h`;
  }
  const d = Math.floor(ms / DAY);
  return `${d}d`;
}

/**
 * Is this old enough to be a problem?
 *
 * One day, and the threshold is a judgement rather than a measurement: a
 * working day is the longest something can wait before "I'll get to it"
 * has quietly become "nobody is going to". Used to mark rows, never to
 * hide them — an aging queue that starts dropping its oldest entries is
 * the failure it exists to prevent.
 */
export function isStale(createdAt: number, now: number): boolean {
  return now - createdAt >= DAY;
}

/**
 * Oldest first.
 *
 * The single most important line in this module: every source it replaces
 * sorted newest-first, which buries exactly the obligation most likely to
 * have been forgotten. Ties break on kind so the order is stable between
 * renders rather than dependent on which query answered first.
 */
export function sortObligations(rows: readonly Obligation[]): Obligation[] {
  return [...rows].sort(
    (a, b) => a.createdAt - b.createdAt || a.kind.localeCompare(b.kind),
  );
}

/** How many, and how many of those have waited too long. */
export function summarize(
  rows: readonly Obligation[],
  now: number,
): { total: number; stale: number } {
  return {
    total: rows.length,
    stale: rows.filter((r) => isStale(r.createdAt, now)).length,
  };
}
