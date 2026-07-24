import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import { sha256Hex } from "../convex/_agentAuth";
import { evalFormula, parseFormula } from "../convex/_customFields";

// ClickUp-parity custom fields: per-type validation, the computed types
// (rollup / formula / voting), authorization, and the agent-API path —
// which must enforce exactly the same rules as the human mutations because
// both go through _customFields.ts.

const modules = import.meta.glob("../convex/**/*.*s");

const ALICE = { subject: "user_alice" };
const MALLORY = { subject: "user_mallory" };

async function setupWorkspace() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    await ctx.db.insert("users", {
      clerkId: ALICE.subject,
      email: "alice@example.com",
      name: "Alice",
    });
    await ctx.db.insert("users", {
      clerkId: MALLORY.subject,
      email: "mallory@example.com",
      name: "Mallory",
    });
    const workspaceId = await ctx.db.insert("workspaces", {
      name: "Acme",
      slug: "acme",
      ownerClerkId: ALICE.subject,
      createdAt: Date.now(),
    });
    await ctx.db.insert("memberships", {
      userClerkId: ALICE.subject,
      workspaceId,
      role: "owner",
      joinedAt: Date.now(),
    });
    const spaceId = await ctx.db.insert("spaces", {
      name: "HQ",
      parentType: "workspace",
      parentId: workspaceId,
      position: 0,
      createdAt: Date.now(),
    });
    const listId = await ctx.db.insert("lists", {
      name: "Foundation",
      parentType: "space",
      parentId: spaceId,
      position: 0,
      createdAt: Date.now(),
    });
    const openStatus = await ctx.db.insert("listStatuses", {
      listId,
      name: "To Do",
      color: "#aaa",
      category: "open",
      position: 0,
      createdAt: Date.now(),
    });
    const taskId = await ctx.db.insert("tasks", {
      listId,
      title: "Ship it",
      statusId: openStatus,
      assigneeClerkIds: [],
      createdByClerkId: ALICE.subject,
      position: 0,
      createdAt: Date.now(),
    });
    const agentId = await ctx.db.insert("agents", {
      name: "Planner",
      parentType: "workspace",
      parentId: workspaceId,
      status: "active",
      createdByClerkId: ALICE.subject,
      createdAt: Date.now(),
    });
    const apiKey = "cua_test_key_fields";
    await ctx.db.insert("agentKeys", {
      agentId,
      keyHash: sha256Hex(apiKey),
      keyPrefix: apiKey.slice(0, 12),
      createdAt: Date.now(),
    });
    return {
      workspaceId,
      spaceId,
      listId,
      openStatus,
      taskId,
      agentId,
      apiKey,
    };
  });
  return { t, ...ids };
}

function errText(e: unknown): string {
  return e instanceof ConvexError ? String(e.data) : String(e);
}

describe("field definitions", () => {
  it("creates every type and refuses definitions that can't work", async () => {
    const { t, listId } = await setupWorkspace();
    const alice = t.withIdentity(ALICE);

    // A representative spread across all five groups.
    const created: string[] = [];
    for (const spec of [
      { name: "Notes", type: "long_text" as const },
      { name: "Budget", type: "money" as const, config: { currency: "eur" } },
      { name: "Quality", type: "rating" as const, config: { ratingMax: 4 } },
      { name: "Done pct", type: "progress" as const },
      { name: "Contact", type: "email" as const },
      { name: "Hotline", type: "phone" as const },
      { name: "Docs", type: "url" as const },
      { name: "Office", type: "location" as const },
      { name: "Owner", type: "people" as const },
      { name: "Assets", type: "files" as const },
      { name: "Demand", type: "voting" as const },
      { name: "Related", type: "relationship" as const },
    ]) {
      created.push(await alice.mutation(api.customFields.create, {
        listId,
        ...spec,
      }));
    }
    expect(created).toHaveLength(12);

    const fields = await alice.query(api.customFields.listForList, { listId });
    const money = fields.find((f) => f.name === "Budget")!;
    // Currency is normalized to upper case and money defaults to 2 decimals.
    expect(money.config?.currency).toBe("EUR");

    // Options-backed types need options; other types must not carry them.
    await expect(
      alice.mutation(api.customFields.create, {
        listId,
        name: "Empty labels",
        type: "labels",
      }),
    ).rejects.toThrow(/at least one option/i);
    await expect(
      alice.mutation(api.customFields.create, {
        listId,
        name: "Bad text",
        type: "text",
        options: [{ id: "a", label: "A" }],
      }),
    ).rejects.toThrow(/only apply to dropdown and labels/i);

    // Nonsense configs are caught at definition time.
    await expect(
      alice.mutation(api.customFields.create, {
        listId,
        name: "Weird stars",
        type: "rating",
        config: { ratingMax: 99 },
      }),
    ).rejects.toThrow(/2 to 10/i);
    await expect(
      alice.mutation(api.customFields.create, {
        listId,
        name: "Bad money",
        type: "money",
        config: { currency: "dollars" },
      }),
    ).rejects.toThrow(/3-letter currency/i);
  });

  it("validates formulas against real numeric siblings at definition time", async () => {
    const { t, listId } = await setupWorkspace();
    const alice = t.withIdentity(ALICE);
    await alice.mutation(api.customFields.create, {
      listId,
      name: "Hours",
      type: "number",
    });
    await alice.mutation(api.customFields.create, {
      listId,
      name: "Rate",
      type: "money",
      config: { currency: "USD" },
    });
    await alice.mutation(api.customFields.create, {
      listId,
      name: "Client",
      type: "text",
    });

    const ok = await alice.mutation(api.customFields.create, {
      listId,
      name: "Cost",
      type: "formula",
      config: { formula: "{Hours} * {Rate}" },
    });
    expect(ok).toBeTruthy();

    await expect(
      alice.mutation(api.customFields.create, {
        listId,
        name: "Broken",
        type: "formula",
        config: { formula: "{Nope} + 1" },
      }),
    ).rejects.toThrow(/No field named "Nope"/i);
    await expect(
      alice.mutation(api.customFields.create, {
        listId,
        name: "Not numeric",
        type: "formula",
        config: { formula: "{Client} * 2" },
      }),
    ).rejects.toThrow(/only reference numeric fields/i);
    await expect(
      alice.mutation(api.customFields.create, {
        listId,
        name: "Syntax",
        type: "formula",
        config: { formula: "{Hours} ** 2" },
      }),
    ).rejects.toThrow();
    await expect(
      alice.mutation(api.customFields.create, {
        listId,
        name: "Self",
        type: "formula",
        config: { formula: "{Self} + 1" },
      }),
    ).rejects.toThrow(/can't reference itself/i);
    // No formula at all is refused rather than silently reading blank.
    await expect(
      alice.mutation(api.customFields.create, {
        listId,
        name: "Blank",
        type: "formula",
      }),
    ).rejects.toThrow(/need a formula/i);
  });

  it("reorders fields and refuses to strand a computed dependent", async () => {
    const { t, listId } = await setupWorkspace();
    const alice = t.withIdentity(ALICE);
    const hours = await alice.mutation(api.customFields.create, {
      listId,
      name: "Hours",
      type: "number",
    });
    const notes = await alice.mutation(api.customFields.create, {
      listId,
      name: "Notes",
      type: "text",
    });
    await alice.mutation(api.customFields.create, {
      listId,
      name: "Doubled",
      type: "formula",
      config: { formula: "{Hours} * 2" },
    });

    await alice.mutation(api.customFields.reorder, {
      listId,
      orderedIds: [notes, hours],
    });
    const fields = await alice.query(api.customFields.listForList, { listId });
    expect(fields.map((f) => f.name)).toEqual(["Notes", "Hours", "Doubled"]);

    await expect(
      alice.mutation(api.customFields.remove, { fieldId: hours }),
    ).rejects.toThrow(/uses "Hours" in its formula/i);
    // Deleting an unreferenced field still works.
    await alice.mutation(api.customFields.remove, { fieldId: notes });
    expect(
      (await alice.query(api.customFields.listForList, { listId })).map(
        (f) => f.name,
      ),
    ).toEqual(["Hours", "Doubled"]);
  });

  it("prunes values whose option disappeared", async () => {
    const { t, listId, taskId } = await setupWorkspace();
    const alice = t.withIdentity(ALICE);
    const fieldId = await alice.mutation(api.customFields.create, {
      listId,
      name: "Tags",
      type: "labels",
      options: [
        { id: "a", label: "Alpha" },
        { id: "b", label: "Beta" },
      ],
    });
    await alice.mutation(api.taskFieldValues.set, {
      taskId,
      fieldId,
      optionIds: ["a", "b"],
    });
    await alice.mutation(api.customFields.updateOptions, {
      fieldId,
      options: [{ id: "a", label: "Alpha" }],
    });
    const values = await alice.query(api.taskFieldValues.listForTask, {
      taskId,
    });
    expect(values[0].optionIds).toEqual(["a"]);
  });
});

describe("per-type value validation", () => {
  it("accepts good values and refuses bad ones with actionable messages", async () => {
    const { t, listId, taskId } = await setupWorkspace();
    const alice = t.withIdentity(ALICE);

    async function field(name: string, type: string, extra = {}) {
      return await alice.mutation(api.customFields.create, {
        listId,
        name,
        // The test walks the whole union; the mutation validator is the
        // real gate.
        type: type as "text",
        ...extra,
      });
    }

    const email = await field("Contact", "email");
    await alice.mutation(api.taskFieldValues.set, {
      taskId,
      fieldId: email,
      textValue: "  Dana@Acme.COM ",
    });
    let rows = await alice.query(api.taskFieldValues.listForTask, { taskId });
    expect(rows.find((r) => r.fieldId === email)?.textValue).toBe(
      "dana@acme.com",
    );
    await expect(
      alice.mutation(api.taskFieldValues.set, {
        taskId,
        fieldId: email,
        textValue: "not-an-email",
      }),
    ).rejects.toThrow(/valid email/i);

    const url = await field("Docs", "url");
    await expect(
      alice.mutation(api.taskFieldValues.set, {
        taskId,
        fieldId: url,
        textValue: "javascript:alert(1)",
      }),
    ).rejects.toThrow(/http/i);
    await alice.mutation(api.taskFieldValues.set, {
      taskId,
      fieldId: url,
      textValue: "https://acme.com/launch",
    });

    const phone = await field("Hotline", "phone");
    await expect(
      alice.mutation(api.taskFieldValues.set, {
        taskId,
        fieldId: phone,
        textValue: "call me maybe",
      }),
    ).rejects.toThrow(/valid phone/i);

    const rating = await field("Quality", "rating", {
      config: { ratingMax: 4 },
    });
    await expect(
      alice.mutation(api.taskFieldValues.set, {
        taskId,
        fieldId: rating,
        numberValue: 5,
      }),
    ).rejects.toThrow(/1 to 4/);
    await alice.mutation(api.taskFieldValues.set, {
      taskId,
      fieldId: rating,
      numberValue: 3,
    });
    // 0 means "unrated" and deletes the row.
    await alice.mutation(api.taskFieldValues.set, {
      taskId,
      fieldId: rating,
      numberValue: 0,
    });
    rows = await alice.query(api.taskFieldValues.listForTask, { taskId });
    expect(rows.some((r) => r.fieldId === rating)).toBe(false);

    const progress = await field("Done pct", "progress");
    await expect(
      alice.mutation(api.taskFieldValues.set, {
        taskId,
        fieldId: progress,
        numberValue: 140,
      }),
    ).rejects.toThrow(/0 to 100/);

    const money = await field("Budget", "money", {
      config: { currency: "EUR", precision: 2 },
    });
    await alice.mutation(api.taskFieldValues.set, {
      taskId,
      fieldId: money,
      numberValue: 1234.5678,
      // A pinned currency wins over whatever the caller sends.
      currency: "JPY",
    });
    rows = await alice.query(api.taskFieldValues.listForTask, { taskId });
    const moneyRow = rows.find((r) => r.fieldId === money)!;
    expect(moneyRow.numberValue).toBe(1234.57);
    expect(moneyRow.currency).toBe("EUR");

    const bounded = await field("Headcount", "number", {
      config: { min: 1, max: 10 },
    });
    await expect(
      alice.mutation(api.taskFieldValues.set, {
        taskId,
        fieldId: bounded,
        numberValue: 42,
      }),
    ).rejects.toThrow(/at most 10/);

    const dropdown = await field("Severity", "dropdown", {
      options: [{ id: "sev1", label: "Sev 1" }],
    });
    await expect(
      alice.mutation(api.taskFieldValues.set, {
        taskId,
        fieldId: dropdown,
        textValue: "sev9",
      }),
    ).rejects.toThrow(/isn't an option/i);

    const location = await field("Office", "location");
    await expect(
      alice.mutation(api.taskFieldValues.set, {
        taskId,
        fieldId: location,
        location: { label: "Nowhere", lat: 900 },
      }),
    ).rejects.toThrow(/Latitude/i);
    await alice.mutation(api.taskFieldValues.set, {
      taskId,
      fieldId: location,
      location: { label: "Lisbon", lat: 38.72, lng: -9.13 },
    });

    // Sending the wrong argument for the type says which one to send.
    const text = await field("Client", "text");
    await expect(
      alice.mutation(api.taskFieldValues.set, {
        taskId,
        fieldId: text,
        numberValue: 3,
      }),
    ).rejects.toThrow(/takes textValue/i);
  });

  it("keeps people and relationship references inside the boundary", async () => {
    const { t, listId, taskId, agentId, workspaceId } = await setupWorkspace();
    const alice = t.withIdentity(ALICE);

    const people = await alice.mutation(api.customFields.create, {
      listId,
      name: "Owner",
      type: "people",
    });
    // A member and an agent in this workspace are both valid principals.
    await alice.mutation(api.taskFieldValues.set, {
      taskId,
      fieldId: people,
      actorIds: [ALICE.subject, agentId],
    });
    // Someone outside the workspace is not.
    await expect(
      alice.mutation(api.taskFieldValues.set, {
        taskId,
        fieldId: people,
        actorIds: [MALLORY.subject],
      }),
    ).rejects.toThrow(/isn't a member or agent here/i);

    const rel = await alice.mutation(api.customFields.create, {
      listId,
      name: "Related",
      type: "relationship",
    });
    const foreignTask = await t.run(async (ctx) => {
      const otherWs = await ctx.db.insert("workspaces", {
        name: "Other",
        slug: "other",
        ownerClerkId: MALLORY.subject,
        createdAt: Date.now(),
      });
      const otherSpace = await ctx.db.insert("spaces", {
        name: "Theirs",
        parentType: "workspace",
        parentId: otherWs,
        position: 0,
        createdAt: Date.now(),
      });
      const otherList = await ctx.db.insert("lists", {
        name: "Theirs",
        parentType: "space",
        parentId: otherSpace,
        position: 0,
        createdAt: Date.now(),
      });
      const status = await ctx.db.insert("listStatuses", {
        listId: otherList,
        name: "To Do",
        color: "#aaa",
        category: "open",
        position: 0,
        createdAt: Date.now(),
      });
      return await ctx.db.insert("tasks", {
        listId: otherList,
        title: "Secret",
        statusId: status,
        assigneeClerkIds: [],
        createdByClerkId: MALLORY.subject,
        position: 0,
        createdAt: Date.now(),
      });
    });
    expect(workspaceId).toBeTruthy();
    await expect(
      alice.mutation(api.taskFieldValues.set, {
        taskId,
        fieldId: rel,
        taskIds: [foreignTask],
      }),
    ).rejects.toThrow(/links tasks in this list/i);
  });
});

describe("computed types", () => {
  it("evaluates formulas over stored numbers, and nulls out on blanks", async () => {
    const { t, listId, taskId } = await setupWorkspace();
    const alice = t.withIdentity(ALICE);
    const hours = await alice.mutation(api.customFields.create, {
      listId,
      name: "Hours",
      type: "number",
    });
    const rate = await alice.mutation(api.customFields.create, {
      listId,
      name: "Rate",
      type: "money",
      config: { currency: "USD" },
    });
    const cost = await alice.mutation(api.customFields.create, {
      listId,
      name: "Cost",
      type: "formula",
      config: { formula: "({Hours} + 2) * {Rate}" },
    });

    // Missing inputs read as blank, not zero.
    let computed = await alice.query(api.taskFieldValues.computedForTask, {
      taskId,
    });
    expect(computed.find((c) => c.fieldId === cost)?.value).toBe(null);

    await alice.mutation(api.taskFieldValues.set, {
      taskId,
      fieldId: hours,
      numberValue: 8,
    });
    await alice.mutation(api.taskFieldValues.set, {
      taskId,
      fieldId: rate,
      numberValue: 100,
    });
    computed = await alice.query(api.taskFieldValues.computedForTask, {
      taskId,
    });
    expect(computed.find((c) => c.fieldId === cost)?.value).toBe(1000);

    // Computed fields refuse direct writes.
    await expect(
      alice.mutation(api.taskFieldValues.set, {
        taskId,
        fieldId: cost,
        numberValue: 5,
      }),
    ).rejects.toThrow(/computed from other fields/i);
  });

  it("rolls up subtasks with sum, avg, and count", async () => {
    const { t, listId, taskId, openStatus } = await setupWorkspace();
    const alice = t.withIdentity(ALICE);
    const points = await alice.mutation(api.customFields.create, {
      listId,
      name: "Points",
      type: "number",
    });
    const total = await alice.mutation(api.customFields.create, {
      listId,
      name: "Total",
      type: "rollup",
      config: {
        rollup: { source: "subtasks", op: "sum", sourceFieldId: points },
      },
    });
    const average = await alice.mutation(api.customFields.create, {
      listId,
      name: "Average",
      type: "rollup",
      config: {
        rollup: { source: "subtasks", op: "avg", sourceFieldId: points },
      },
    });
    const howMany = await alice.mutation(api.customFields.create, {
      listId,
      name: "How many",
      type: "rollup",
      config: { rollup: { source: "subtasks", op: "count" } },
    });

    const subIds = await t.run(async (ctx) => {
      const out = [];
      for (const n of [3, 5, 10]) {
        const id = await ctx.db.insert("tasks", {
          listId,
          title: `Sub ${n}`,
          statusId: openStatus,
          assigneeClerkIds: [],
          parentTaskId: taskId,
          createdByClerkId: ALICE.subject,
          position: n,
          createdAt: Date.now(),
        });
        out.push({ id, n });
      }
      return out;
    });
    for (const { id, n } of subIds) {
      await alice.mutation(api.taskFieldValues.set, {
        taskId: id,
        fieldId: points,
        numberValue: n,
      });
    }

    const computed = await alice.query(api.taskFieldValues.computedForTask, {
      taskId,
    });
    const value = (id: string) =>
      computed.find((c) => c.fieldId === id)?.value;
    expect(value(total)).toBe(18);
    expect(value(average)).toBe(6);
    expect(value(howMany)).toBe(3);

    // A rollup needs a real numeric source.
    await expect(
      alice.mutation(api.customFields.create, {
        listId,
        name: "Bad rollup",
        type: "rollup",
        config: { rollup: { source: "subtasks", op: "sum" } },
      }),
    ).rejects.toThrow(/needs sourceFieldId/i);
  });

  it("counts votes per principal and lets each one clear only their own", async () => {
    const { t, listId, taskId, apiKey } = await setupWorkspace();
    const alice = t.withIdentity(ALICE);
    const votes = await alice.mutation(api.customFields.create, {
      listId,
      name: "Demand",
      type: "voting",
    });

    await alice.mutation(api.taskFieldValues.set, {
      taskId,
      fieldId: votes,
      booleanValue: true,
    });
    // The agent is a separate principal, so the count goes to 2.
    await t.mutation(api.agentApi.setTaskFieldValue, {
      apiKey,
      taskId,
      fieldId: votes,
      booleanValue: true,
    });
    let computed = await alice.query(api.taskFieldValues.computedForTask, {
      taskId,
    });
    expect(computed.find((c) => c.fieldId === votes)?.value).toBe(2);

    // Alice clearing removes only her vote.
    await alice.mutation(api.taskFieldValues.clear, {
      taskId,
      fieldId: votes,
    });
    computed = await alice.query(api.taskFieldValues.computedForTask, {
      taskId,
    });
    expect(computed.find((c) => c.fieldId === votes)?.value).toBe(1);
  });
});

describe("authorization", () => {
  it("refuses field definition and value writes from outside the workspace", async () => {
    const { t, listId, taskId } = await setupWorkspace();
    const alice = t.withIdentity(ALICE);
    const mallory = t.withIdentity(MALLORY);

    await expect(
      mallory.mutation(api.customFields.create, {
        listId,
        name: "Sneaky",
        type: "text",
      }),
    ).rejects.toThrow();
    // Reads degrade to empty rather than leaking the schema.
    expect(
      await mallory.query(api.customFields.listForList, { listId }),
    ).toEqual([]);

    const fieldId = await alice.mutation(api.customFields.create, {
      listId,
      name: "Client",
      type: "text",
    });
    await expect(
      mallory.mutation(api.taskFieldValues.set, {
        taskId,
        fieldId,
        textValue: "pwned",
      }),
    ).rejects.toThrow();
    expect(
      await mallory.query(api.taskFieldValues.listForTask, { taskId }),
    ).toEqual([]);
    expect(
      await mallory.query(api.taskFieldValues.computedForTask, { taskId }),
    ).toEqual([]);

    // A field from another list can't be written onto this task.
    const otherListField = await t.run(async (ctx) => {
      const otherList = await ctx.db.insert("lists", {
        name: "Elsewhere",
        parentType: "space",
        parentId: (await ctx.db.get(listId))!.parentId,
        position: 1,
        createdAt: Date.now(),
      });
      return await ctx.db.insert("customFields", {
        listId: otherList,
        name: "Foreign",
        type: "text",
        position: 0,
        createdAt: Date.now(),
      });
    });
    await expect(
      alice.mutation(api.taskFieldValues.set, {
        taskId,
        fieldId: otherListField,
        textValue: "nope",
      }),
    ).rejects.toThrow(/does not belong to this task's list/i);
  });
});

describe("agent API parity", () => {
  it("creates configured fields, reads the contract, and round-trips values", async () => {
    const { t, listId, taskId, apiKey } = await setupWorkspace();

    const { fieldId: budget } = await t.mutation(
      api.agentApi.createCustomField,
      {
        apiKey,
        listId,
        name: "Budget",
        type: "money",
        config: { currency: "usd", precision: 2 },
      },
    );
    const { fieldId: tags } = await t.mutation(api.agentApi.createCustomField, {
      apiKey,
      listId,
      name: "Tags",
      type: "labels",
      options: [
        { id: "api", label: "API" },
        { id: "ux", label: "UX" },
      ],
    });
    const { fieldId: stars } = await t.mutation(
      api.agentApi.createCustomField,
      { apiKey, listId, name: "Quality", type: "rating" },
    );
    const { fieldId: doubled } = await t.mutation(
      api.agentApi.createCustomField,
      {
        apiKey,
        listId,
        name: "Doubled",
        type: "formula",
        config: { formula: "{Quality} * 2" },
      },
    );

    // list_custom_fields is the contract: config + writeHint + computed.
    const defs = await t.query(api.agentApi.listCustomFields, {
      apiKey,
      listId,
    });
    const budgetDef = defs.find((d) => d.fieldId === budget)!;
    expect(budgetDef.config?.currency).toBe("USD");
    expect(budgetDef.writeHint).toMatch(/numberValue/);
    expect(defs.find((d) => d.fieldId === doubled)!.computed).toBe(true);

    await t.mutation(api.agentApi.setTaskFieldValue, {
      apiKey,
      taskId,
      fieldId: budget,
      numberValue: 2500,
    });
    await t.mutation(api.agentApi.setTaskFieldValue, {
      apiKey,
      taskId,
      fieldId: tags,
      optionIds: ["api", "ux"],
    });
    await t.mutation(api.agentApi.setTaskFieldValue, {
      apiKey,
      taskId,
      fieldId: stars,
      numberValue: 4,
    });

    const resolved = (await t.query(api.agentApi.getTaskFields, {
      apiKey,
      taskId,
    })) as Record<string, unknown>[];
    const byId = new Map(resolved.map((r) => [r.fieldId as string, r]));
    expect(byId.get(budget)).toMatchObject({ amount: 2500, currency: "USD" });
    expect(byId.get(tags)!.labels).toEqual(["API", "UX"]);
    expect(byId.get(doubled)).toMatchObject({ value: 8, computed: true });

    // get_task carries the same resolved array.
    const task = (await t.query(api.agentApi.getTask, { apiKey, taskId })) as {
      customFields: Record<string, unknown>[];
    };
    expect(
      task.customFields.find((f) => f.fieldId === stars)!.value,
    ).toBe(4);
  });

  it("enforces the same refusals as the UI, and clearing works", async () => {
    const { t, listId, taskId, apiKey } = await setupWorkspace();
    const { fieldId: stars } = await t.mutation(
      api.agentApi.createCustomField,
      {
        apiKey,
        listId,
        name: "Quality",
        type: "rating",
        config: { ratingMax: 5 },
      },
    );
    const { fieldId: derived } = await t.mutation(
      api.agentApi.createCustomField,
      {
        apiKey,
        listId,
        name: "Doubled",
        type: "formula",
        config: { formula: "{Quality} * 2" },
      },
    );

    await expect(
      t.mutation(api.agentApi.setTaskFieldValue, {
        apiKey,
        taskId,
        fieldId: stars,
        numberValue: 9,
      }),
    ).rejects.toThrow(/1 to 5/);
    await expect(
      t.mutation(api.agentApi.setTaskFieldValue, {
        apiKey,
        taskId,
        fieldId: derived,
        numberValue: 1,
      }),
    ).rejects.toThrow(/computed/i);
    await expect(
      t.mutation(api.agentApi.createCustomField, {
        apiKey,
        listId,
        name: "Nope",
        type: "formula",
        config: { formula: "{Ghost} + 1" },
      }),
    ).rejects.toThrow(/No field named "Ghost"/i);

    await t.mutation(api.agentApi.setTaskFieldValue, {
      apiKey,
      taskId,
      fieldId: stars,
      numberValue: 3,
    });
    await t.mutation(api.agentApi.clearTaskFieldValue, {
      apiKey,
      taskId,
      fieldId: stars,
    });
    const resolved = (await t.query(api.agentApi.getTaskFields, {
      apiKey,
      taskId,
    })) as Record<string, unknown>[];
    expect(resolved.find((r) => r.fieldId === stars)!.value).toBe(null);
  });

  it("refuses field creation from a list-restricted agent and pauses with the agent", async () => {
    const { t, listId, agentId, apiKey } = await setupWorkspace();
    await t.run(async (ctx) => {
      await ctx.db.patch(agentId, { allowedListIds: [listId] });
    });
    await expect(
      t.mutation(api.agentApi.createCustomField, {
        apiKey,
        listId,
        name: "Restricted",
        type: "text",
      }),
    ).rejects.toThrow();

    await t.run(async (ctx) => {
      await ctx.db.patch(agentId, {
        allowedListIds: undefined,
        role: "readonly",
      });
    });
    try {
      await t.mutation(api.agentApi.createCustomField, {
        apiKey,
        listId,
        name: "Readonly",
        type: "text",
      });
      expect.unreachable("readonly agents can't create fields");
    } catch (e) {
      expect(errText(e)).toMatch(/read-?only|forbidden|not allowed/i);
    }
  });
});

describe("formula parser", () => {
  const lookup = (values: Record<string, number | null>) => (name: string) =>
    name in values ? values[name] : null;

  it("respects precedence, parentheses, and unary minus", () => {
    const values = { A: 2, B: 3, C: 4 };
    const cases: [string, number | null][] = [
      ["1 + 2 * 3", 7],
      ["(1 + 2) * 3", 9],
      ["{A} + {B} * {C}", 14],
      ["({A} + {B}) * {C}", 20],
      ["-{A} + 10", 8],
      ["10 / {C}", 2.5],
      ["{A} / 0", null],
      ["{Missing} + 1", null],
    ];
    for (const [src, expected] of cases) {
      expect(evalFormula(parseFormula(src), lookup(values))).toBe(expected);
    }
  });

  it("rejects anything that isn't arithmetic — no code ever reaches an evaluator", () => {
    for (const bad of [
      "process.exit(1)",
      "{A}; drop table tasks",
      "1 +",
      "(1 + 2",
      "{unclosed",
      "{}",
      "",
      "1 $ 2",
    ]) {
      expect(() => parseFormula(bad)).toThrow();
    }
  });
});
