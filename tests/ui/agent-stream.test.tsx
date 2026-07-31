import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { DashboardShell, queryResults, resetHarness } from "./harness";

// The live agent card.
//
// It answers "are my agents working right now", which the general activity
// feed cannot: that feed is everything and everyone, and on any real account
// the machines' work is buried under your own edits. Three properties carry
// the whole feature, and each of them fails silently if it breaks — the card
// still renders, it just stops being about agents.

vi.mock("@/components/motion", async () => await import("./motion-mock"));

const { AgentStream } = await import("@/components/dashboard/agent-stream");

let seq = 0;
function event(over: Record<string, unknown> = {}) {
  seq += 1;
  return {
    _id: `e${seq}`,
    type: "task.claimed",
    entityType: "task",
    entityId: `t${seq}`,
    entityTitle: `Task ${seq}`,
    listId: "l1",
    scopeType: "user",
    scopeId: "user_a",
    actorType: "agent",
    actorId: "ag1",
    actorName: "Ada",
    createdAt: 1_000 + seq,
    ...over,
  };
}

function show(events: unknown[] | undefined, props: object = {}) {
  queryResults["events.feed"] = events;
  return render(
    <DashboardShell>
      <AgentStream {...props} />
    </DashboardShell>,
  );
}

beforeEach(() => {
  resetHarness();
  seq = 0;
});

describe("what it shows", () => {
  it("shows an agent's actions", () => {
    show([event({ entityTitle: "Ship the migration" })]);
    expect(screen.getByText("Ship the migration")).toBeTruthy();
    expect(screen.getByText("Ada")).toBeTruthy();
  });

  it("leaves out everything a person or the system did", () => {
    // The point of the card. Without this it is the activity feed with a
    // different heading, and the heading would be a lie.
    show([
      event({ actorType: "user", actorName: "Grace", entityTitle: "Human edit" }),
      event({ actorType: "system", actorName: "operate", entityTitle: "Cron run" }),
      event({ entityTitle: "Agent work" }),
    ]);
    expect(screen.getByText("Agent work")).toBeTruthy();
    expect(screen.queryByText("Human edit")).toBeNull();
    expect(screen.queryByText("Cron run")).toBeNull();
  });

  it("keeps the newest first, whatever order it is handed", () => {
    // `AnimatedList` treats index 0 as the newest and does not sort, so the
    // feed's own ordering has to survive the filter.
    show([
      event({ entityTitle: "Newest", createdAt: 300 }),
      event({ entityTitle: "Middle", createdAt: 200 }),
      event({ entityTitle: "Oldest", createdAt: 100 }),
    ]);
    const titles = screen
      .getAllByText(/Newest|Middle|Oldest/)
      .map((el) => el.textContent);
    expect(titles).toEqual(["Newest", "Middle", "Oldest"]);
  });

  it("caps what is on screen without dropping what is loaded", () => {
    show(Array.from({ length: 12 }, (_, i) => event({ entityTitle: `Row ${i}` })), {
      limit: 4,
    });
    expect(screen.getAllByText(/^Row \d+$/).length).toBe(4);
  });

  it("links a task to the page it happened on", () => {
    show([event({ entityTitle: "Ship it" })]);
    const link = screen.getByText("Ship it").closest("a");
    expect(link?.getAttribute("href")).toContain("/dashboard/l/l1/t/t1");
  });
});

describe("when there is nothing", () => {
  it("says what would appear here rather than showing a blank card", () => {
    // A card that is empty and silent on a new account reads as broken, which
    // is the opposite of what a first-run surface should say.
    show([]);
    expect(screen.getByText(/Nothing from your agents yet/)).toBeTruthy();
  });

  it("says the same thing when only people have done anything", () => {
    show([event({ actorType: "user", actorName: "Grace" })]);
    expect(screen.getByText(/Nothing from your agents yet/)).toBeTruthy();
  });

  it("shows a placeholder rather than an empty state while loading", () => {
    // Undefined is "not answered yet", and calling that "nothing yet" tells a
    // returning user their agents stopped working every time the page loads.
    show(undefined);
    expect(screen.queryByText(/Nothing from your agents yet/)).toBeNull();
  });
});
