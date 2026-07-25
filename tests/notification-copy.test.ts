import { describe, expect, it } from "vitest";
import { safeNotificationBody } from "../src/lib/notification-copy";

describe("safeNotificationBody", () => {
  it("replaces a legacy schedule assignee stack trace with actionable copy", () => {
    expect(
      safeNotificationBody(
        "schedule_failed",
        "Uncaught ConvexError: Agent assignee is outside this task's scope at validateTaskAssignees (../../convex/tasks.ts:281:22)",
      ),
    ).toBe(
      "The assigned agent no longer has access to this list. Choose another assignee or update its access.",
    );
  });

  it("replaces other backend diagnostics with generic recovery guidance", () => {
    expect(
      safeNotificationBody(
        "schedule_failed",
        "Uncaught ConvexError: Internal failure at async handler (../../convex/scheduledTasks.ts:285:10)",
      ),
    ).toBe(
      "The task could not be created. Check the schedule settings, then retry.",
    );
  });

  it("preserves already-safe schedule copy and unrelated notifications", () => {
    const safe =
      "The task could not be created. Check the schedule settings, then retry.";
    expect(safeNotificationBody("schedule_failed", safe)).toBe(safe);
    expect(safeNotificationBody("mention", "Please review the launch plan.")).toBe(
      "Please review the launch plan.",
    );
  });
});
