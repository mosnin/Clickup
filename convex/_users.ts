import type { MutationCtx, QueryCtx } from "./_generated/server";

// Convex indexes are not unique constraints. The Clerk webhook and
// users.ensureCurrent can both insert a users row on first login;
// .unique() then throws on every later visit. Home's InviteCards and the
// workspace-switch member list both look this index up during render, and
// useQuery rethrows that as a client exception. One of the rows is enough.
export async function userByClerkId(
  ctx: QueryCtx | MutationCtx,
  clerkId: string,
) {
  return await ctx.db
    .query("users")
    .withIndex("by_clerk_id", (q) => q.eq("clerkId", clerkId))
    .first();
}
