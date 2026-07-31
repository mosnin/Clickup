import { cronJobs } from "convex/server";
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

crons.interval(
  "prune old events, deliveries, and usage counters",
  { hours: 24 },
  internal.maintenance.prune,
  {},
);

export default crons;
