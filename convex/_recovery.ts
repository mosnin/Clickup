// What to do with an attempt that stopped.
//
// The execution lifecycle already models abandonment: the schema says
// "expired, unclaimed work becomes eligible for a later recovery wave", the
// `attempt` column exists, and both the watchdog and reconcile produce
// abandoned rows. Nothing was ever on the other side. Recovery required a
// human or an orchestrator to notice and dispatch again, which is precisely
// the thing unattended operation is supposed to remove. This is finishing a
// mechanism rather than adding one.
//
// The decision is pure so it can be tested without a backend, and because the
// interesting part is not the database work — it is the three-way choice.
//
// **Retry** while attempts remain and the work is unchanged.
//
// **Reset** when the context changed underneath it. This is the case that
// looks like a retry and is not: the packets the previous attempt read have
// moved, so its failure says nothing about whether the next one will fail.
// Counting it against the cap would burn a task's retries on evidence that no
// longer applies, and skipping it — which the roadmap suggested — strands work
// that is now perfectly viable. Neither. The attempt count starts again,
// because this is genuinely different work.
//
// **Escalate** at the cap. Not "retry forever with a longer gap": something
// that has failed three times with the same inputs will fail a fourth, and the
// only thing another round buys is a bigger bill.

/** How many attempts before a person has to look. */
export const MAX_EXECUTION_ATTEMPTS = 3;

/**
 * How long to leave an abandoned attempt alone before recovering it.
 *
 * Not zero, and this is the property that keeps recovery from fighting the
 * thing that produced it: an agent whose claim lapsed for two minutes may
 * simply be slow, and re-offering its task immediately means two workers on it
 * the moment it comes back. The delay is longer than the heartbeat window that
 * declared it abandoned in the first place.
 */
export const RECOVERY_DELAY_MS = 10 * 60 * 1000;

export type AbandonedAttempt = {
  assignmentId: string;
  taskId: string;
  attempt: number;
  finishedAt?: number;
  /** The context fingerprint recorded when this attempt was dispatched. */
  contextVersionFingerprint?: string;
  /** When recovery last re-offered it, if it has. */
  lastRecoveredAt?: number;
};

export type RecoveryDecision =
  | { action: "wait"; reason: "too_soon" }
  | { action: "retry"; attempt: number }
  | { action: "reset"; attempt: number; reason: "context_changed" }
  | { action: "escalate"; attempts: number };

/**
 * What should happen to one abandoned attempt.
 *
 * `currentFingerprint` is the task's context as it stands NOW. `undefined` on
 * either side means "not recorded" — an older row, or a task with no packets —
 * and two unknowns are treated as unchanged rather than as a change. Guessing
 * the other way would reset the attempt counter on every legacy row and turn
 * the cap into decoration.
 */
export function decideRecovery(
  attempt: AbandonedAttempt,
  currentFingerprint: string | undefined,
  now: number,
): RecoveryDecision {
  // The clock runs from the last re-offer where there has been one: a task
  // handed back two minutes ago has not had time to be picked up, and
  // re-offering it again would be this pass racing itself.
  const since = attempt.lastRecoveredAt ?? attempt.finishedAt;
  if (since === undefined || now - since < RECOVERY_DELAY_MS) {
    return { action: "wait", reason: "too_soon" };
  }

  const before = attempt.contextVersionFingerprint;
  const changed =
    before !== undefined &&
    currentFingerprint !== undefined &&
    before !== currentFingerprint;

  if (changed) {
    // Different work. The previous failure is not evidence about this one.
    return { action: "reset", attempt: 1, reason: "context_changed" };
  }

  if (attempt.attempt >= MAX_EXECUTION_ATTEMPTS) {
    return { action: "escalate", attempts: attempt.attempt };
  }

  return { action: "retry", attempt: attempt.attempt + 1 };
}

/** What a person is told when the retries run out. */
export function describeExhaustion(attempts: number): string {
  return `Dispatched ${attempts} times and abandoned every time — the next attempt would be the fourth with the same inputs. Something about this task or its context needs changing before it is worth trying again.`;
}
