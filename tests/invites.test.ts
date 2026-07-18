import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";

// Workspace invites: only owner/admin can send them, duplicates and
// already-members are rejected, and there are two acceptance paths
// (in-app email match vs. capability-link token) with independent gates.

const modules = import.meta.glob("../convex/**/*.*s");

const OWNER = { subject: "user_owner", email: "owner@acme.com" };
const ADMIN = { subject: "user_admin", email: "admin@acme.com" };
const MEMBER = { subject: "user_member", email: "member@acme.com" };
const OUTSIDER = { subject: "user_outsider", email: "outsider@acme.com" };

async function seed(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    for (const u of [OWNER, ADMIN, MEMBER, OUTSIDER]) {
      await ctx.db.insert("users", { clerkId: u.subject, email: u.email });
    }
    const workspaceId = await ctx.db.insert("workspaces", {
      name: "Acme",
      slug: "acme",
      ownerClerkId: OWNER.subject,
      createdAt: Date.now(),
    });
    await ctx.db.insert("memberships", {
      workspaceId,
      userClerkId: OWNER.subject,
      role: "owner",
      joinedAt: Date.now(),
    });
    await ctx.db.insert("memberships", {
      workspaceId,
      userClerkId: ADMIN.subject,
      role: "admin",
      joinedAt: Date.now(),
    });
    await ctx.db.insert("memberships", {
      workspaceId,
      userClerkId: MEMBER.subject,
      role: "member",
      joinedAt: Date.now(),
    });
    return workspaceId;
  });
}

describe("invites", () => {
  it("owner and admin can create invites; a plain member cannot", async () => {
    const t = convexTest(schema, modules);
    const workspaceId = await seed(t);

    const { inviteId } = await t
      .withIdentity(OWNER)
      .mutation(api.invites.create, {
        workspaceId,
        email: "new-hire@acme.com",
        role: "member",
      });
    expect(inviteId).toBeTruthy();

    const { inviteId: adminInvite } = await t
      .withIdentity(ADMIN)
      .mutation(api.invites.create, {
        workspaceId,
        email: "second-hire@acme.com",
        role: "member",
      });
    expect(adminInvite).toBeTruthy();

    await expect(
      t.withIdentity(MEMBER).mutation(api.invites.create, {
        workspaceId,
        email: "third-hire@acme.com",
        role: "member",
      }),
    ).rejects.toThrow(/owners and admins/i);
  });

  it("rejects a duplicate pending invite to the same email", async () => {
    const t = convexTest(schema, modules);
    const workspaceId = await seed(t);
    await t.withIdentity(OWNER).mutation(api.invites.create, {
      workspaceId,
      email: "dup@acme.com",
      role: "member",
    });
    await expect(
      t.withIdentity(OWNER).mutation(api.invites.create, {
        workspaceId,
        email: "dup@acme.com",
        role: "member",
      }),
    ).rejects.toThrow(/already pending/i);
  });

  it("rejects inviting an email that already belongs to a member", async () => {
    const t = convexTest(schema, modules);
    const workspaceId = await seed(t);
    await expect(
      t.withIdentity(OWNER).mutation(api.invites.create, {
        workspaceId,
        email: MEMBER.email,
        role: "member",
      }),
    ).rejects.toThrow(/already a member/i);
  });

  it("in-app accept requires the signed-in email to match the invite", async () => {
    const t = convexTest(schema, modules);
    const workspaceId = await seed(t);
    const { inviteId } = await t
      .withIdentity(OWNER)
      .mutation(api.invites.create, {
        workspaceId,
        email: OUTSIDER.email,
        role: "member",
      });

    // A different signed-in user (email mismatch) is refused.
    await expect(
      t.withIdentity(MEMBER).mutation(api.invites.accept, { inviteId }),
    ).rejects.toThrow(/different email/i);

    // The actual invitee accepts and becomes a member.
    const { workspaceId: joined } = await t
      .withIdentity(OUTSIDER)
      .mutation(api.invites.accept, { inviteId });
    expect(joined).toBe(workspaceId);

    const membership = await t.run(async (ctx) => {
      return await ctx.db
        .query("memberships")
        .withIndex("by_user_and_workspace", (q) =>
          q.eq("userClerkId", OUTSIDER.subject).eq("workspaceId", workspaceId),
        )
        .unique();
    });
    expect(membership).not.toBeNull();
    expect(membership?.role).toBe("member");
  });

  it("acceptByToken works for any signed-in holder of the link", async () => {
    const t = convexTest(schema, modules);
    const workspaceId = await seed(t);
    const { token } = await t.withIdentity(OWNER).mutation(api.invites.create, {
      workspaceId,
      email: "link-target@acme.com",
      role: "admin",
    });

    // OUTSIDER's own email doesn't match the invite, but the token path
    // doesn't require that — anyone holding the link may accept.
    const { workspaceId: joined } = await t
      .withIdentity(OUTSIDER)
      .mutation(api.invites.acceptByToken, { token });
    expect(joined).toBe(workspaceId);

    const membership = await t.run(async (ctx) => {
      return await ctx.db
        .query("memberships")
        .withIndex("by_user_and_workspace", (q) =>
          q.eq("userClerkId", OUTSIDER.subject).eq("workspaceId", workspaceId),
        )
        .unique();
    });
    expect(membership?.role).toBe("admin");
  });

  it("revoked invites can no longer be accepted by either path", async () => {
    const t = convexTest(schema, modules);
    const workspaceId = await seed(t);
    const { inviteId, token } = await t
      .withIdentity(OWNER)
      .mutation(api.invites.create, {
        workspaceId,
        email: OUTSIDER.email,
        role: "member",
      });

    await t.withIdentity(OWNER).mutation(api.invites.revoke, { inviteId });

    await expect(
      t.withIdentity(OUTSIDER).mutation(api.invites.accept, { inviteId }),
    ).rejects.toThrow(/no longer valid/i);
    await expect(
      t.withIdentity(MEMBER).mutation(api.invites.acceptByToken, { token }),
    ).rejects.toThrow(/no longer valid/i);
  });

  it("getByToken flips pending:false once the invite is accepted", async () => {
    const t = convexTest(schema, modules);
    const workspaceId = await seed(t);
    const { token } = await t.withIdentity(OWNER).mutation(api.invites.create, {
      workspaceId,
      email: "flip@acme.com",
      role: "member",
    });

    const before = await t
      .withIdentity(OUTSIDER)
      .query(api.invites.getByToken, { token });
    expect(before?.pending).toBe(true);

    await t.withIdentity(OUTSIDER).mutation(api.invites.acceptByToken, {
      token,
    });

    const after = await t
      .withIdentity(MEMBER)
      .query(api.invites.getByToken, { token });
    expect(after?.pending).toBe(false);
  });
});
