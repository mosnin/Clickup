import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";

// Production /dashboard white-screen — verified cause.
//
// This account created several user-scoped spaces (Chippi, Stored, Operate,
// Govern, Scalar, Glove, Fortitudo, Founder) under parentType "user" / the
// same Clerk subject. spaces.create allows that. Both crashing functions
// then did:
//
//   query("spaces").withIndex("by_parent", q =>
//     q.eq("parentType", "user").eq("parentId", subject)).unique()
//
// Convex .unique() throws when more than one row matches. That is exactly
// the production errors:
//   Q(homeOverview:get)  Request IDs 0ebdc58417b2d834, ae7c3b07ba60f2df
//   M(users:ensureCurrent) Request IDs 434d16e04e92caf7, b01f649cdfb94ddd
//
// Clerk token exchange was 200. Convex said Server Error, not "Could not
// find public function". The company spaces must stay; Personal is the
// default seed, not a uniqueness invariant.

const modules = import.meta.glob("../convex/**/*.*s");

const ME = { subject: "user_founder", email: "founder@operate.to" };
const COMPANIES = [
  "Chippi",
  "Stored",
  "Operate",
  "Govern",
  "Scalar",
  "Glove",
  "Fortitudo",
  "Founder",
] as const;

async function seedUserScopedCompanySpaces() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    await ctx.db.insert("users", { clerkId: ME.subject, email: ME.email });
    const now = Date.now();
    const personalId = await ctx.db.insert("spaces", {
      name: "Personal",
      parentType: "user",
      parentId: ME.subject,
      position: 0,
      createdAt: now,
    });
    const companyIds: Record<string, string> = {};
    for (const [i, name] of COMPANIES.entries()) {
      companyIds[name] = await ctx.db.insert("spaces", {
        name,
        parentType: "user",
        parentId: ME.subject,
        position: i + 1,
        createdAt: now + i + 1,
      });
    }
    const chippiListId = await ctx.db.insert("lists", {
      name: "HQ",
      parentType: "space",
      parentId: companyIds.Chippi,
      position: 0,
      createdAt: now,
    });
    return { personalId, companyIds, chippiListId };
  });
  return { t, ...ids };
}

describe("multiple user-scoped spaces must not take the dashboard down", () => {
  it("lets Home see every company space, not just the first", async () => {
    const { t } = await seedUserScopedCompanySpaces();
    const overview = await t.withIdentity(ME).query(api.homeOverview.get, {});
    expect(overview).toMatchObject({ me: expect.any(Object) });
    const names = overview!.projects.map((p) => p.name);
    expect(names).toContain("HQ");
    const places = overview!.projects.map((p) => p.place);
    expect(places.some((place) => place.includes("Chippi"))).toBe(true);
  });

  it("lets My Work, Agents, and the sidebar load every user-scoped space", async () => {
    const { t } = await seedUserScopedCompanySpaces();
    const asMe = t.withIdentity(ME);

    await expect(asMe.query(api.myWork.listForCurrent, {})).resolves.toEqual([]);
    await expect(asMe.query(api.agents.listForCurrentUser, {})).resolves.toMatchObject({
      personal: [],
    });

    const tree = await asMe.query(api.sidebar.tree, {});
    expect(tree?.personal?.name).toBe("Personal");
    const spaceNames = (tree?.personalSpaces ?? []).map((s) => s.name);
    expect(spaceNames).toContain("Personal");
    for (const name of COMPANIES) expect(spaceNames).toContain(name);
  });

  it("lets ensureCurrent run without deleting company spaces or inserting a second Personal", async () => {
    const { t } = await seedUserScopedCompanySpaces();
    await t.withIdentity(ME).mutation(api.users.ensureCurrent, {});
    const spaces = await t.run(async (ctx) => {
      return await ctx.db
        .query("spaces")
        .withIndex("by_parent", (q) =>
          q.eq("parentType", "user").eq("parentId", ME.subject),
        )
        .collect();
    });
    const names = spaces.map((s) => s.name).sort();
    expect(names).toEqual(["Chippi", "Fortitudo", "Founder", "Glove", "Govern", "Operate", "Personal", "Scalar", "Stored"].sort());
    expect(names.filter((n) => n === "Personal")).toHaveLength(1);
  });

  it("still refuses grantFleet without a human identity", async () => {
    const t = convexTest(schema, modules);
    const holderAgentId = await t.run(async (ctx) => {
      return await ctx.db.insert("agents", {
        name: "Orchestrator",
        parentType: "user",
        parentId: ME.subject,
        status: "active",
        createdByClerkId: ME.subject,
        createdAt: Date.now(),
      });
    });
    await expect(
      t.mutation(api.agentGrants.grantFleet, {
        holderAgentId,
        role: "member",
        dailyActionLimit: 1000,
      }),
    ).rejects.toThrow(/not authenticated/i);
    expect(readFileSync("convex/agentGrants.ts", "utf8")).toMatch(
      /export const grantFleet = mutation\([\s\S]*requireIdentity\(ctx\)/,
    );
  });
});

describe("the signed-in shell has a real error boundary", () => {
  it("ships app, global, and dashboard error.tsx files", () => {
    for (const path of [
      "src/app/error.tsx",
      "src/app/global-error.tsx",
      "src/app/dashboard/error.tsx",
    ]) {
      const source = readFileSync(path, "utf8");
      expect(source).toMatch(/export default function/);
      expect(source).toMatch(/Try again/);
    }
  });

  it("wraps dashboard pages in a query error boundary inside the shell", () => {
    const layout = readFileSync("src/app/dashboard/layout.tsx", "utf8");
    expect(layout).toMatch(/QueryErrorBoundary/);
    const boundary = readFileSync(
      "src/components/dashboard/query-error-boundary.tsx",
      "utf8",
    );
    expect(boundary).toMatch(/getDerivedStateFromError/);
    expect(boundary).toMatch(/Try again/);
  });
});
