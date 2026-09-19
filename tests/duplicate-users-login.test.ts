import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";

// Production login / workspace-switch crash — same root cause as PR #48.
//
// Clerk webhook + users.ensureCurrent can both insert a users row for the
// same clerkId. Convex indexes are not unique constraints. Home always
// subscribes to invites.listForCurrentUser (InviteCards), and switching
// workspaces always subscribes to workspaces.listMembers (member count in
// the header). Both still called .unique() on by_clerk_id. unique() throws
// when more than one row matches; useQuery rethrows that during render.
//
// requireIdentity / homeOverview already tolerate the duplicate. These two
// queries did not — so the signed-in shell survived Home's overview query
// and then died on the invite strip, or died the moment you opened a
// workspace.

const modules = import.meta.glob("../convex/**/*.*s");

const ME = { subject: "user_founder", email: "founder@operate.to" };
const TEAMMATE = { subject: "user_teammate", email: "teammate@operate.to" };

async function seedDuplicateUsers() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    // The first-login race: two users rows, same clerkId.
    await ctx.db.insert("users", {
      clerkId: ME.subject,
      email: ME.email,
      name: "Founder",
    });
    await ctx.db.insert("users", {
      clerkId: ME.subject,
      email: ME.email,
      name: "Founder (webhook)",
    });
    await ctx.db.insert("users", {
      clerkId: TEAMMATE.subject,
      email: TEAMMATE.email,
      name: "Teammate",
    });
    await ctx.db.insert("spaces", {
      name: "Personal",
      parentType: "user",
      parentId: ME.subject,
      position: 0,
      createdAt: Date.now(),
    });
    const workspaceId = await ctx.db.insert("workspaces", {
      name: "Acme",
      slug: "acme",
      ownerClerkId: TEAMMATE.subject,
      createdAt: Date.now(),
    });
    await ctx.db.insert("memberships", {
      workspaceId,
      userClerkId: TEAMMATE.subject,
      role: "owner",
      joinedAt: Date.now(),
    });
    await ctx.db.insert("memberships", {
      workspaceId,
      userClerkId: ME.subject,
      role: "member",
      joinedAt: Date.now(),
    });
    const inviteId = await ctx.db.insert("invites", {
      workspaceId,
      email: ME.email,
      role: "member",
      token: "tok_pending",
      invitedByClerkId: TEAMMATE.subject,
      createdAt: Date.now(),
    });
    return { workspaceId, inviteId };
  });
  return { t, ...ids };
}

describe("duplicate users rows must not take the signed-in shell down", () => {
  it("lets Home load pending invites (InviteCards) without unique() throwing", async () => {
    const { t } = await seedDuplicateUsers();
    const invites = await t
      .withIdentity(ME)
      .query(api.invites.listForCurrentUser, {});
    expect(invites).toHaveLength(1);
    expect(invites[0]).toMatchObject({
      workspaceName: "Acme",
      invitedBy: "Teammate",
      role: "member",
    });
  });

  it("lets a workspace switch load the member list without unique() throwing", async () => {
    const { t, workspaceId } = await seedDuplicateUsers();
    const members = await t
      .withIdentity(ME)
      .query(api.workspaces.listMembers, { workspaceId });
    const clerkIds = members.map((m) => m.clerkId).sort();
    expect(clerkIds).toEqual([ME.subject, TEAMMATE.subject].sort());
    const me = members.find((m) => m.clerkId === ME.subject);
    expect(me?.role).toBe("member");
    expect(me?.email).toBe(ME.email);
  });

  it("lets the invitee accept from Home and land in the workspace", async () => {
    const { t, inviteId, workspaceId } = await seedDuplicateUsers();
    const asMe = t.withIdentity(ME);
    const result = await asMe.mutation(api.invites.accept, { inviteId });
    expect(result.workspaceId).toBe(workspaceId);
    const members = await asMe.query(api.workspaces.listMembers, {
      workspaceId,
    });
    expect(members.some((m) => m.clerkId === ME.subject)).toBe(true);
  });
});
