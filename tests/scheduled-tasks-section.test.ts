import { describe, expect, it } from "vitest";
import { scheduleFailureMessage } from "../src/lib/schedule-errors";

describe("scheduleFailureMessage", () => {
  it("turns an assignee scope failure into actionable product language", () => {
    expect(
      scheduleFailureMessage(
        "Uncaught ConvexError: Agent assignee is outside this task's scope at validateTaskAssignees (../../convex/tasks.ts:281:22)",
      ),
    ).toBe(
      "The assigned agent no longer has access to this list. Choose another assignee or update its access.",
    );
  });

  it("does not expose unknown internal error details", () => {
    const internal =
      "Uncaught Error: secret backend detail at handler (../../convex/private.ts:42:1)";
    expect(scheduleFailureMessage(internal)).toBe(
      "The task could not be created. Check the schedule settings, then retry.",
    );
    expect(scheduleFailureMessage(internal)).not.toContain("secret backend");
    expect(scheduleFailureMessage(internal)).not.toContain("convex/");
  });
});
