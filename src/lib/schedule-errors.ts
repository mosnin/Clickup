// Convex errors can include function names and source locations. Keep those in
// the server-side audit trail, but never expose them through a browser tooltip.
export function scheduleFailureMessage(error: string): string {
  const normalized = error.toLowerCase();
  if (normalized.includes("assignee") && normalized.includes("scope")) {
    return "The assigned agent no longer has access to this list. Choose another assignee or update its access.";
  }
  return "The task could not be created. Check the schedule settings, then retry.";
}
