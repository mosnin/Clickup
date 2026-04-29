import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

// Daily + interval cron jobs.
//
// 03:00 UTC: walk every soft-deleted row across tasks/lists/folders/
// docs/whiteboards and hard-delete anything past the 30-day retention
// window. Trash items remain restorable up to that point.
//
// Every 5 minutes: drop stale presence rows so the table doesn't grow
// past the active session set.
const crons = cronJobs();

crons.daily(
  "purge expired soft-deletes",
  { hourUTC: 3, minuteUTC: 0 },
  internal.trash.purgeExpired,
);

crons.interval(
  "sweep stale presence",
  { minutes: 5 },
  internal.presence.sweepStale,
);

export default crons;
