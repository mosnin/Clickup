import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { queryResults, resetHarness } from "./harness";
import { CalendarView } from "@/app/dashboard/l/[listId]/views/calendar-view";
import type { Doc, Id } from "@convex/_generated/dataModel";

const listId = "list_calendar" as Id<"lists">;

function scheduledFor(day = 15, hour = 9) {
  const current = new Date();
  return new Date(current.getFullYear(), current.getMonth(), day, hour).getTime();
}

function planned(id: string, title: string, hour = 9) {
  return {
    scheduledTaskId: id as Id<"scheduledTasks">,
    title,
    scheduledFor: scheduledFor(15, hour),
    state: "planned" as const,
    lastError: undefined,
  };
}

function task(id: string, title: string) {
  return {
    _id: id as Id<"tasks">,
    title,
    dueDate: scheduledFor(),
  } as Doc<"tasks">;
}

describe("calendar recurring schedule preview", () => {
  beforeEach(() => resetHarness());

  it("distinguishes a planned creation from a real task and links to schedule management", () => {
    queryResults["scheduledTasks.calendarForList"] = [planned("schedule_1", "Standup digest")];
    render(<CalendarView listId={listId} tasks={[task("task_1", "Already created")]} />);

    const future = screen.getByText(/Planned .* · Standup digest/);
    expect(future.closest("a")).toBeNull();
    expect(future.getAttribute("title")).toMatch(/Not yet a task/);
    expect(screen.getByRole("link", { name: "Already created" })).not.toBeNull();
    expect(screen.getByRole("link", { name: "Manage recurring schedules" }).getAttribute("href"))
      .toBe(`/dashboard/l/${listId}/settings#recurring-schedules`);
  });

  it("keeps the existing overflow control usable when tasks and planned entries share a day", () => {
    queryResults["scheduledTasks.calendarForList"] = [
      planned("schedule_1", "Standup digest", 9),
      planned("schedule_2", "Health review", 10),
      planned("schedule_3", "Invoice check", 11),
    ];
    render(<CalendarView listId={listId} tasks={[task("task_1", "Already created")]} />);

    expect(screen.queryByText(/Invoice check/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "+1 more" }));
    expect(screen.getByText(/Planned .* · Invoice check/)).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show less" }));
    expect(screen.queryByText(/Invoice check/)).toBeNull();
  });

  it("shows a loading state only while recurrence data is unresolved", () => {
    const view = render(<CalendarView listId={listId} tasks={[]} />);
    expect(screen.getByText(/Loading recurring schedules/)).not.toBeNull();
    queryResults["scheduledTasks.calendarForList"] = [];
    view.rerender(<CalendarView listId={listId} tasks={[]} />);
    expect(screen.queryByText(/Loading recurring schedules/)).toBeNull();
    expect(screen.getByText(/Planned entries show recurring creation times/)).not.toBeNull();
  });
});
