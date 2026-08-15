import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";

// The production /dashboard white-screen.
//
// Clerk webhook `users.upsertFromClerk` and the dashboard's `users.ensureCurrent`
// can both insert a personal space on first login. Convex indexes are not
// unique constraints, so the race leaves two rows. Queries that then call
// `.unique()` throw during render; `useQuery` rethrows that to React; and
// without an App Router error.tsx, Next.js replaces the signed-in shell with
// "Application error: a client-side exception has occurred".
//
// The sidebar already used `.first()` for this. Home (`homeOverview.get`) and
// My Work (`myWork.listForCurrent`) — both subscribed on /dashboard — did not.

const modules = import.meta.glob("../convex/**/*.*s");

const ME = { subject: "user_dup", email: "dup@operate.to" };

async function seedDuplicatePersonalSpaces() {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    await ctx.db.insert("users", { clerkId: ME.subject, email: ME.email });
    const now = Date.now();
    await ctx.db.insert("spaces", {
      name: "Personal",
      parentType: "user",
      parentId: ME.subject,
      position: 0,
      createdAt: now,
    });
    await ctx.db.insert("spaces", {
      name: "Personal",
      parentType: "user",
      parentId: ME.subject,
      position: 1,
      createdAt: now + 1,
    });
  });
  return t;
}

describe("duplicate personal spaces must not take the dashboard down", () => {
  it("lets Home, My Work, Agents, and the sidebar load", async () => {
    const t = await seedDuplicatePersonalSpaces();
    const asMe = t.withIdentity(ME);

    await expect(asMe.query(api.homeOverview.get, {})).resolves.toMatchObject({
      me: expect.any(Object),
    });
    await expect(asMe.query(api.myWork.listForCurrent, {})).resolves.toEqual([]);
    await expect(asMe.query(api.agents.listForCurrentUser, {})).resolves.toMatchObject({
      personal: [],
    });
    await expect(asMe.query(api.sidebar.tree, {})).resolves.toMatchObject({
      currentClerkId: ME.subject,
    });
  });

  it("lets ensureCurrent heal instead of throwing", async () => {
    const t = await seedDuplicatePersonalSpaces();
    await t.withIdentity(ME).mutation(api.users.ensureCurrent, {});
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
    // Human-only fleet grant policy: an unauthenticated (or agent-key) caller
    // must not be able to grant a fleet. Do not "fix" the dashboard crash by
    // relaxing this — grantFleet stays on requireIdentity.
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
    // The production crash was this exact Next.js default page, which is what
    // you get when none of these files exist. A test that only exercises the
    // query would miss the wiring the way the missing EnsureChatIdentity did.
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
});
