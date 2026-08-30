import { anyApi, cronJobs } from "convex/server";
import { internal } from "./_generated/api";

// Scheduled jobs. scheduledTasks definitions carry an hourUtc, so a
// 15-minute tick keeps materialization within a quarter hour of the
// requested time. The watchdog shares the cadence so expired claims and
// stalled agents are flagged promptly.
const crons = cronJobs();

crons.interval(
  "materialize scheduled tasks",
  { minutes: 15 },
  internal.scheduledTasks.materializeDue,
  {},
);

// Grading shares the watchdog's cadence. A claim with a horizon in days does
// not need checking to the minute, and a separate schedule would be a second
// thing to reason about for no gain.
crons.interval(
  "grade decisions whose horizon has passed",
  { minutes: 15 },
  internal.calibration.gradeDue,
  {},
);

crons.interval(
  "watchdog: stuck claims, overdue tasks, stalled agents",
  { minutes: 15 },
  internal.maintenance.watchdog,
  {},
);

// Situations share the cadence too. A condition over a team's work does not
// change meaningfully inside fifteen minutes, and the dead band is sized on the
// assumption that a value is sampled four times an hour rather than constantly.
crons.interval(
  "evaluate panel situations",
  { minutes: 15 },
  internal.situations.evaluateDue,
  {},
);

// Reminders. Five minutes rather than fifteen because a reminder is a promise
// about a *time* somebody chose — "in 30 minutes" is one of the presets, and a
// quarter-hour of slop on that is the difference between a reminder and a
// notification about something that already happened. The pass is idempotent by
// construction (it clears the `dueAt` it selected on), so a tick that overlaps
// the previous one delivers nothing twice, and a tick that is missed entirely
// loses nothing — see convex/buzz/reminders.ts.
//
// Named through `anyApi` rather than `internal.buzz.reminders`, for the reason
// `convex/buzz/keys.ts` documents: the checked-in `_generated/api.d.ts` is a
// hand-rolled stub that predates `convex/buzz/`, so the typed path does not
// exist until `npx convex dev` regenerates it. The runtime path is identical
// (`internal` *is* `anyApi`). **Replace this with `internal.buzz.reminders.fireDue`
// the first time the CLI regenerates the stub.**
crons.interval(
  "fire reminders that have come due",
  { minutes: 5 },
  anyApi.buzz.reminders.fireDue,
  {},
);

// The window must match the cadence: it is the tolerance for tick drift, and a
// window narrower than the gap between ticks silently drops fires.
crons.interval(
  "fire scheduled Chat workflows",
  { minutes: 15 },
  anyApi.buzz.workflows.tickAllScheduled,
  { windowSecs: 900 },
);

crons.interval(
  "prune old events, deliveries, and usage counters",
  { hours: 24 },
  internal.maintenance.prune,
  {},
);

crons.interval(
  "prune OAuth authorization-code replay evidence",
  { hours: 24 },
  internal.maintenance.pruneOAuthAuthorizationCodes,
  {},
);

crons.interval(
  "prune OAuth refresh-token replay evidence",
  { hours: 24 },
  internal.maintenance.pruneOAuthAccessTokens,
  {},
);

export default crons;
