// Detecting repetition.
//
// Lives in `convex/` rather than `src/lib/` because only the watchdog reads it,
// and every other pure Convex helper is here for the same reason (`_refs`,
// `_x402`, `_customFields`). The Convex bundler roots at this directory; a pure
// module the backend depends on is not worth putting on the far side of that
// boundary for tidiness.
//
// Every safety net in this product detects ABSENCE. An expired claim, a
// missing heartbeat, an overdue date, a stalled agent — all of them notice
// that something stopped. Nothing notices something happening over and over,
// and a loop is what an unattended agent actually does when it is wrong: it
// claims, tries, fails, releases, claims the same task again. Every existing
// check reads that as health. The claim is fresh, the heartbeat is regular,
// the run history is full of activity. Meanwhile it is burning budget on the
// same task all night, which is why this pairs with the spend ceiling — the
// ceiling stops the bleeding, this names the wound.
//
// The rule is deliberately the narrowest one that catches the common shape:
// repeated FAILURE against one task inside a window. Status flip-flops and two
// actors alternating writes are real thrash too, and both are cheaper to add
// once this exists than to design for now.
//
// The three properties that make it usable rather than noisy:
//
// **A window, not a total.** A task that failed twice in March and once today
// is not thrashing; it is a hard task with a long history. Only failures
// inside the window count, so the signal decays on its own and a task can
// recover without anybody clearing anything.
//
// **News, not a state.** The watchdog runs every fifteen minutes. A detector
// that fires whenever the condition holds would announce the same loop ninety
// times a day, and a queue full of the same row is a queue people stop
// reading. So it fires only when there is a failure the last notice did not
// already cover — meaning a loop that gets WORSE speaks up again, and a loop
// somebody is already looking at stays quiet.
//
// **The count is of runs, not of attempts to read them.** Deduped by run id,
// because the caller reads overlapping windows on every pass and a detector
// whose answer depends on how it was asked is not a detector.

/** How far back a failure still counts toward the pattern. */
export const THRASH_WINDOW_MS = 6 * 60 * 60 * 1000;

/**
 * How many failures inside the window make it a loop.
 *
 * Three, not two. Two failures is an agent having a bad time with a genuinely
 * hard task, which is ordinary and self-correcting; three inside six hours is
 * a thing that is not going to fix itself by being tried again.
 */
export const THRASH_THRESHOLD = 3;

export type ThrashRun = {
  /** The run's own id — the dedupe key. */
  id: string;
  taskId: string;
  agentId: string;
  /** `failed` and `abandoned` both count; see below. */
  status: string;
  /** When the run ended. A run still going has not failed yet. */
  finishedAt?: number;
};

export type ThrashFinding = {
  taskId: string;
  /** Failures inside the window. */
  failures: number;
  /** Every agent that failed on it — a loop is often one agent, not always. */
  agentIds: string[];
  /** The most recent failure, which is what "news" is measured against. */
  latestAt: number;
};

/**
 * Does this run count as a failure?
 *
 * `abandoned` counts alongside `failed`, and that is a decision rather than an
 * oversight. An abandoned run is one the watchdog closed because the agent
 * went silent holding it — from the task's point of view that is
 * indistinguishable from failing, and excluding it would make the single most
 * common loop (claim, hang, get reaped, claim again) invisible to the one
 * check built to see loops.
 */
function isFailure(run: ThrashRun): boolean {
  return run.status === "failed" || run.status === "abandoned";
}

/**
 * Find tasks being failed at repeatedly.
 *
 * `since` is the caller's per-task record of what it has already reported —
 * a task is only returned if a failure landed after its own entry, so a loop
 * nobody has fixed does not re-announce itself every fifteen minutes.
 * Absent from the map means never reported.
 */
export function detectThrash(
  runs: ThrashRun[],
  now: number,
  since: Record<string, number | undefined> = {},
): ThrashFinding[] {
  const cutoff = now - THRASH_WINDOW_MS;
  const seen = new Set<string>();
  const byTask = new Map<
    string,
    { failures: number; agentIds: Set<string>; latestAt: number }
  >();

  for (const run of runs) {
    if (!isFailure(run)) continue;
    // A run still going has not failed. `finishedAt` is what says it is over,
    // so a row without one is not evidence of anything yet.
    if (run.finishedAt === undefined) continue;
    if (run.finishedAt < cutoff) continue;
    // The caller reads overlapping windows every pass; the same run arriving
    // twice must not count twice.
    if (seen.has(run.id)) continue;
    seen.add(run.id);

    const entry = byTask.get(run.taskId);
    if (entry) {
      entry.failures += 1;
      entry.agentIds.add(run.agentId);
      entry.latestAt = Math.max(entry.latestAt, run.finishedAt);
    } else {
      byTask.set(run.taskId, {
        failures: 1,
        agentIds: new Set([run.agentId]),
        latestAt: run.finishedAt,
      });
    }
  }

  const findings: ThrashFinding[] = [];
  for (const [taskId, entry] of byTask) {
    if (entry.failures < THRASH_THRESHOLD) continue;
    const reportedAt = since[taskId];
    // Nothing new since the last notice — still true, still not news.
    if (reportedAt !== undefined && entry.latestAt <= reportedAt) continue;
    findings.push({
      taskId,
      failures: entry.failures,
      agentIds: [...entry.agentIds].sort(),
      latestAt: entry.latestAt,
    });
  }
  // Worst first. A person clearing this queue should meet the task that has
  // burned the most attempts before the one that has burned the fewest.
  return findings.sort(
    (a, b) => b.failures - a.failures || b.latestAt - a.latestAt,
  );
}

/**
 * What to tell a person, in one line.
 *
 * Names the number and who, because those are the two things that decide what
 * to do next: three failures by one agent is probably the agent, three
 * failures by three agents is probably the task.
 */
export function describeThrash(f: ThrashFinding, agentNames: string[]): string {
  const who =
    agentNames.length === 0
      ? "an agent"
      : agentNames.length === 1
        ? agentNames[0]
        : `${agentNames.length} agents`;
  return `${f.failures} failed attempts by ${who} in the last few hours`;
}
