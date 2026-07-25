const ASSIGNEE_ACCESS_COPY =
  "The assigned agent no longer has access to this list. Choose another assignee or update its access.";

const GENERIC_SCHEDULE_COPY =
  "The task could not be created. Check the schedule settings, then retry.";

/**
 * Historical schedule notifications may contain the raw Convex failure that
 * originally paused the operation. Keep diagnostics in the audit trail, but
 * never render a stack trace in a user-facing notification.
 */
export function safeNotificationBody(type: string, body: string): string {
  if (type !== "schedule_failed" || !body) return body;

  const normalized = body.toLowerCase();
  if (normalized.includes("assignee") && normalized.includes("scope")) {
    return ASSIGNEE_ACCESS_COPY;
  }

  const looksLikeDiagnostic =
    normalized.includes("convexerror") ||
    normalized.includes("uncaught ") ||
    normalized.includes("../../convex/") ||
    /\bat\s+(async\s+)?[\w$.<>]+\s*\(/i.test(body);

  return looksLikeDiagnostic ? GENERIC_SCHEDULE_COPY : body;
}
