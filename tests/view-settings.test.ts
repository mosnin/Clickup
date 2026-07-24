import { describe, expect, it } from "vitest";
import {
  DEFAULT_VIEW_SETTINGS,
  allFieldKeys,
  isCustomized,
  normalizeViewSettings,
  parseViewSettings,
  resolveVisibleFields,
  writeViewSettingsToParams,
  type ViewSettings,
} from "../src/lib/view-settings";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import { MAX_LIST_VIEW_SETTINGS } from "../convex/userSettings";
import type { Id } from "../convex/_generated/dataModel";

// The Customize view panel's whole contract is "the link reproduces the
// view", so the encoding is the thing worth pinning down.

function roundTrip(settings: ViewSettings): ViewSettings {
  const params = writeViewSettingsToParams(new URLSearchParams(), settings);
  // Serialize + reparse the way a real navigation would.
  return parseViewSettings(new URLSearchParams(params.toString()));
}

describe("view settings encoding", () => {
  it("leaves the URL untouched for an unmodified view", () => {
    const params = writeViewSettingsToParams(
      new URLSearchParams(),
      DEFAULT_VIEW_SETTINGS,
    );
    expect(params.toString()).toBe("");
    expect(isCustomized(DEFAULT_VIEW_SETTINGS)).toBe(false);
  });

  it("round-trips every setting", () => {
    const settings: ViewSettings = {
      emptyStatuses: false,
      wrapText: true,
      showClosed: true,
      showLocation: true,
      showSubtaskParents: false,
      group: "assignee",
      subtasks: "flat",
      fields: ["due", "status", "k1234567890"],
    };
    expect(roundTrip(settings)).toEqual(settings);
    expect(isCustomized(settings)).toBe(true);
  });

  it("only serializes what differs from the defaults", () => {
    const params = writeViewSettingsToParams(new URLSearchParams(), {
      ...DEFAULT_VIEW_SETTINGS,
      wrapText: true,
    });
    expect(params.get("vs")).toBe("w1");
    expect(params.get("vf")).toBeNull();
  });

  it("survives a percent-encoding trip through URLSearchParams", () => {
    const params = writeViewSettingsToParams(new URLSearchParams(), {
      ...DEFAULT_VIEW_SETTINGS,
      group: "due",
      subtasks: "expanded",
      emptyStatuses: false,
    });
    // No escaping: the token alphabet stays readable in the address bar.
    expect(params.toString()).toBe("vs=e0.g-due.s-expanded");
  });

  it("distinguishes 'default fields' from 'no fields'", () => {
    const none = writeViewSettingsToParams(new URLSearchParams(), {
      ...DEFAULT_VIEW_SETTINGS,
      fields: [],
    });
    expect(none.get("vf")).toBe("0");
    expect(parseViewSettings(none).fields).toEqual([]);
    expect(parseViewSettings(new URLSearchParams()).fields).toBeNull();
  });

  it("ignores junk instead of throwing", () => {
    const parsed = parseViewSettings(
      new URLSearchParams("vs=zz.g-nonsense.s-.w1"),
    );
    expect(parsed.wrapText).toBe(true);
    expect(parsed.group).toBe(DEFAULT_VIEW_SETTINGS.group);
    expect(parsed.subtasks).toBe(DEFAULT_VIEW_SETTINGS.subtasks);
  });
});

describe("field resolution", () => {
  it("defaults to the built-in trio plus every custom field", () => {
    expect(resolveVisibleFields(DEFAULT_VIEW_SETTINGS, ["cf1", "cf2"])).toEqual(
      ["status", "priority", "due", "cf1", "cf2"],
    );
  });

  it("keeps the chosen order and drops fields that no longer exist", () => {
    const settings = {
      ...DEFAULT_VIEW_SETTINGS,
      fields: ["due", "cf_deleted", "status", "status"],
    };
    expect(resolveVisibleFields(settings, ["cf1"])).toEqual(["due", "status"]);
  });

  it("lists every candidate field for the panel", () => {
    expect(allFieldKeys(["cf1"])).toEqual([
      "status",
      "assignees",
      "priority",
      "start",
      "due",
      "points",
      "cf1",
    ]);
  });
});

describe("normalizeViewSettings", () => {
  it("falls back field by field on a corrupt payload", () => {
    expect(
      normalizeViewSettings({ wrapText: "yes", group: "bogus", fields: 42 }),
    ).toEqual(DEFAULT_VIEW_SETTINGS);
  });

  it("accepts a valid stored payload", () => {
    const stored = normalizeViewSettings({
      ...DEFAULT_VIEW_SETTINGS,
      showClosed: true,
      fields: ["status"],
    });
    expect(stored.showClosed).toBe(true);
    expect(stored.fields).toEqual(["status"]);
  });
});

// ── Server persistence ──────────────────────────────────────────────────
// The same encoding, stored per user per list on `userSettings`, so a saved
// setup follows someone to another device instead of living in one browser.

const modules = import.meta.glob("../convex/**/*.*s");

const ALICE = { subject: "user_alice" };

async function setupList() {
  const t = convexTest(schema, modules);
  const listId = await t.run(async (ctx) => {
    await ctx.db.insert("users", {
      clerkId: ALICE.subject,
      email: "alice@example.com",
      name: "Alice",
    });
    const spaceId = await ctx.db.insert("spaces", {
      name: "Personal",
      parentType: "user",
      parentId: ALICE.subject,
      position: 0,
      createdAt: Date.now(),
    });
    return await ctx.db.insert("lists", {
      name: "Foundation",
      parentType: "space",
      parentId: spaceId,
      position: 0,
      createdAt: Date.now(),
    });
  });
  return { t, listId };
}

type TestCtx = Awaited<ReturnType<typeof setupList>>["t"];

async function storedFor(t: TestCtx) {
  return await t.run(async (ctx) => {
    const row = await ctx.db
      .query("userSettings")
      .withIndex("by_clerk", (q) => q.eq("clerkId", ALICE.subject))
      .first();
    return row?.listViewSettings ?? [];
  });
}

describe("userSettings.setListViewSettings", () => {
  it("stores the vs/vf encoding and reads it back through current", async () => {
    const { t, listId } = await setupList();
    const asAlice = t.withIdentity(ALICE);
    const encoded = writeViewSettingsToParams(new URLSearchParams(), {
      ...DEFAULT_VIEW_SETTINGS,
      wrapText: true,
      group: "status",
      fields: ["status", "due"],
    }).toString();

    await asAlice.mutation(api.userSettings.setListViewSettings, {
      listId,
      settings: encoded,
    });

    const row = await asAlice.query(api.userSettings.current, {});
    expect(row?.listViewSettings).toEqual([{ listId, settings: encoded }]);
    // And it decodes back into exactly what was saved.
    const decoded = parseViewSettings(new URLSearchParams(encoded));
    expect(decoded.wrapText).toBe(true);
    expect(decoded.group).toBe("status");
    expect(decoded.fields).toEqual(["status", "due"]);
  });

  it("upserts by list rather than appending duplicates", async () => {
    const { t, listId } = await setupList();
    const asAlice = t.withIdentity(ALICE);
    await asAlice.mutation(api.userSettings.setListViewSettings, {
      listId,
      settings: "vs=w1",
    });
    await asAlice.mutation(api.userSettings.setListViewSettings, {
      listId,
      settings: "vs=c0",
    });
    expect(await storedFor(t)).toEqual([{ listId, settings: "vs=c0" }]);
  });

  it("drops the entry when the view goes back to the defaults", async () => {
    const { t, listId } = await setupList();
    const asAlice = t.withIdentity(ALICE);
    await asAlice.mutation(api.userSettings.setListViewSettings, {
      listId,
      settings: "vs=w1",
    });
    // An unmodified view encodes to the empty string.
    await asAlice.mutation(api.userSettings.setListViewSettings, {
      listId,
      settings: "",
    });
    expect(await storedFor(t)).toEqual([]);
  });

  it("caps the array, evicting the least recently customized list", async () => {
    const { t, listId } = await setupList();
    const asAlice = t.withIdentity(ALICE);
    const spaceId = await t.run(
      async (ctx) => (await ctx.db.get(listId))!.parentId as Id<"spaces">,
    );
    const extras = await t.run(async (ctx) => {
      const ids: Id<"lists">[] = [];
      for (let i = 0; i < MAX_LIST_VIEW_SETTINGS; i++) {
        ids.push(
          await ctx.db.insert("lists", {
            name: `List ${i}`,
            parentType: "space",
            parentId: spaceId,
            position: i + 1,
            createdAt: Date.now(),
          }),
        );
      }
      return ids;
    });

    // The original list is customized first, so it's the oldest entry.
    await asAlice.mutation(api.userSettings.setListViewSettings, {
      listId,
      settings: "vs=w1",
    });
    for (const id of extras) {
      await asAlice.mutation(api.userSettings.setListViewSettings, {
        listId: id,
        settings: "vs=w1",
      });
    }

    const stored = await storedFor(t);
    expect(stored).toHaveLength(MAX_LIST_VIEW_SETTINGS);
    expect(stored.map((r) => r.listId)).not.toContain(listId);
    // Most recent first.
    expect(stored[0].listId).toBe(extras[extras.length - 1]);
  });

  it("refuses a list the caller can't reach", async () => {
    const { t, listId } = await setupList();
    await expect(
      t
        .withIdentity({ subject: "user_mallory" })
        .mutation(api.userSettings.setListViewSettings, {
          listId,
          settings: "vs=w1",
        }),
    ).rejects.toThrow();
    expect(await storedFor(t)).toEqual([]);
  });
});
