import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

// Scheduled jobs. Keep the cadence coarse — scheduledTasks definitions
// carry an hourUtc, so an hourly tick gives full resolution.
const crons = cronJobs();

crons.interval(
  "materialize scheduled tasks",
  { hours: 1 },
  internal.scheduledTasks.materializeDue,
  {},
);

export default crons;
