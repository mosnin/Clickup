import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";

// Regression coverage for the W2 fix (finding 4): importer.importTasks must
// not silently drop the fact that a CSV row's status name didn't match any
// of the list's statuses — it should count those rows and echo back a
// sample of the unmatched names so the UI can tell the user.

const modules = import.meta.glob("../convex/**/*.*s");

const OWNER = { subject: "user_owner", email: "owner@acme.com" };

async function setup() {
  const t = convexTest(schema, modules);
  const owner = t.withIdentity(OWNER);
  const { listId } = await t.run(async (ctx) => {
    await ctx.db.insert("users", { clerkId: OWNER.subject, email: OWNER.email });
    const spaceId = await ctx.db.insert("spaces", {
      name: "Personal",
      parentType: "user",
      parentId: OWNER.subject,
      position: 0,
      createdAt: Date.now(),
    });
    const listId = await ctx.db.insert("lists", {
      name: "Imported",
      parentType: "space",
      parentId: spaceId,
      position: 0,
      createdAt: Date.now(),
    });
    await ctx.db.insert("listStatuses", {
      listId,
      name: "To Do",
      color: "#aaa",
      category: "open",
      position: 0,
      createdAt: Date.now(),
    });
    await ctx.db.insert("listStatuses", {
      listId,
      name: "Done",
      color: "#0f0",
      category: "complete",
      position: 1,
      createdAt: Date.now(),
    });
    return { listId };
  });
  return { owner, listId };
}

describe("importer.importTasks", () => {
  it("imports every row with a recognized status and reports 0 unmatched", async () => {
    const { owner, listId } = await setup();
    const res = await owner.mutation(api.importer.importTasks, {
      listId,
      rows: [
        { title: "Task A", statusName: "To Do" },
        { title: "Task B", statusName: "done" },
      ],
    });
    expect(res.created).toBe(2);
    expect(res.skipped).toBe(0);
    expect(res.unmatchedStatusCount).toBe(0);
    expect(res.unmatchedStatusNames).toEqual([]);
  });

  it("still creates the task (with the default status) but counts an unmatched status name", async () => {
    const { owner, listId } = await setup();
    const res = await owner.mutation(api.importer.importTasks, {
      listId,
      rows: [
        { title: "Task A", statusName: "Blocked" },
        { title: "Task B", statusName: "Blocked" },
        { title: "Task C", statusName: "In Review" },
        { title: "Task D" }, // no status column at all — not "unmatched"
      ],
    });
    expect(res.created).toBe(4);
    expect(res.unmatchedStatusCount).toBe(3);
    expect(res.unmatchedStatusNames.sort()).toEqual(["Blocked", "In Review"]);
  });

  it("caps the distinct unmatched names it echoes back", async () => {
    const { owner, listId } = await setup();
    const rows = Array.from({ length: 8 }, (_, i) => ({
      title: `Task ${i}`,
      statusName: `Unknown ${i}`,
    }));
    const res = await owner.mutation(api.importer.importTasks, {
      listId,
      rows,
    });
    expect(res.unmatchedStatusCount).toBe(8);
    expect(res.unmatchedStatusNames).toHaveLength(5);
  });
});
