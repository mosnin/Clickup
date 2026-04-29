import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

// Daily cron jobs.
//
// 03:00 UTC: walk every soft-deleted row across tasks/lists/folders/
// docs/whiteboards and hard-delete anything past the 30-day retention
// window. Trash items remain restorable up to that point.
const crons = cronJobs();

crons.daily(
  "purge expired soft-deletes",
  { hourUTC: 3, minuteUTC: 0 },
  internal.trash.purgeExpired,
);

export default crons;
