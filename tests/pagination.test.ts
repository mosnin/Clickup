import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import { sha256Hex } from "../convex/_agentAuth";

const modules = import.meta.glob("../convex/**/*.*s");
const ALICE = { subject: "user_alice" };

describe("MCP list_tasks / search_tasks pagination", () => {
  it("pages across lists and resumes from continueCursor", async () => {
    const t = convexTest(schema, modules);
    const { apiKey } = await t.run(async (ctx) => {
      const spaceId = await ctx.db.insert("spaces", {
        name: "Personal",
        parentType: "user",
        parentId: ALICE.subject,
        position: 0,
        createdAt: Date.now(),
      });
      const apiKey = "cua_page_test";
      const agentId = await ctx.db.insert("agents", {
        name: "Pager",
        parentType: "user",
        parentId: ALICE.subject,
        status: "active",
        createdByClerkId: ALICE.subject,
        createdAt: Date.now(),
      });
      await ctx.db.insert("agentKeys", {
        agentId,
        keyHash: sha256Hex(apiKey),
        keyPrefix: apiKey.slice(0, 12),
        createdAt: Date.now(),
      });

      for (let listN = 0; listN < 3; listN++) {
        const listId = await ctx.db.insert("lists", {
          name: `List ${listN}`,
          parentType: "space",
          parentId: spaceId,
          position: listN,
          createdAt: Date.now(),
        });
        const statusId = await ctx.db.insert("listStatuses", {
          listId,
          name: "To Do",
          color: "#aaa",
          category: "open",
          position: 0,
          createdAt: Date.now(),
        });
        for (let i = 0; i < 15; i++) {
          await ctx.db.insert("tasks", {
            listId,
            title: `alpha-${listN}-${i}`,
            statusId,
            assigneeClerkIds: [],
            createdByClerkId: ALICE.subject,
            position: i,
            createdAt: Date.now(),
          });
        }
      }
      return { apiKey };
    });

    const first = await t.query(api.agentApi.listTasks, {
      apiKey,
      limit: 20,
    });
    expect(first.tasks).toHaveLength(20);
    expect(first.isDone).toBe(false);
    expect(first.continueCursor).toBeTruthy();

    const second = await t.query(api.agentApi.listTasks, {
      apiKey,
      limit: 20,
      cursor: first.continueCursor ?? undefined,
    });
    expect(second.tasks).toHaveLength(20);
    expect(second.isDone).toBe(false);

    const firstIds = new Set(first.tasks.map((row) => row.taskId));
    for (const row of second.tasks) {
      expect(firstIds.has(row.taskId)).toBe(false);
    }

    const rest = await t.query(api.agentApi.listTasks, {
      apiKey,
      limit: 20,
      cursor: second.continueCursor ?? undefined,
    });
    expect(rest.tasks).toHaveLength(5);
    expect(rest.isDone).toBe(true);
    expect(rest.continueCursor).toBeNull();

    const search = await t.query(api.agentApi.searchTasks, {
      apiKey,
      query: "alpha",
      limit: 10,
    });
    expect(search.results).toHaveLength(10);
    expect(search.isDone).toBe(false);
    const searchRest = await t.query(api.agentApi.searchTasks, {
      apiKey,
      query: "alpha",
      limit: 50,
      cursor: search.continueCursor ?? undefined,
    });
    expect(searchRest.results.length).toBeGreaterThan(0);
    expect(searchRest.isDone).toBe(true);
  });
});
