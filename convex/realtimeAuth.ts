import { query } from "./_generated/server";
import { requireIdentity } from "./_authz";

// Which real-time channels the caller is allowed on.
//
// This is the whole tenancy boundary for Ably. The token endpoint
// (src/app/api/ably/token/route.ts) mints a token whose capability list is
// exactly what this query returns, so a client can never subscribe to a scope
// it cannot already read in Convex. Enumerated deliberately — a wildcard like
// `operate:workspace:*` would hand every tenant every other tenant's stream.
//
// Three kinds of channel:
//   operate:inbox:<clerkId>      — this person's own notifications
//   operate:user:<clerkId>       — their personal space's activity
//   operate:workspace:<id>       — one workspace they are a member of
//
// Presence rides the same channels: "who else is looking at this" is scoped to
// people who can see the thing being looked at.

export const channels = query({
  args: {},
  handler: async (ctx) => {
    const identity = await requireIdentity(ctx);
    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userClerkId", identity.subject))
      .collect();

    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
      .unique();

    return {
      clerkId: identity.subject,
      displayName: user?.name ?? user?.email ?? "Someone",
      inbox: `operate:inbox:${identity.subject}`,
      scopes: [
        `operate:user:${identity.subject}`,
        ...memberships.map((m) => `operate:workspace:${m.workspaceId}`),
      ],
    };
  },
});
