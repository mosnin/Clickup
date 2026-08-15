import type { Doc } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";

// A person can own many spaces under parentType "user" — Personal plus
// company spaces (Chippi, Stored, …) created via spaces.create. Convex
// indexes are not unique constraints. .unique() on by_parent throws as
// soon as the second user-scoped space exists, which is what took
// homeOverview.get and users.ensureCurrent down in production.
//
// Collect every non-archived row. "Personal" is the default seed / the
// /dashboard/personal target, never a uniqueness invariant. Never delete
// the extras.

function byPosition(a: Doc<"spaces">, b: Doc<"spaces">): number {
  return a.position - b.position || a.createdAt - b.createdAt;
}

export async function listUserSpaces(
  ctx: QueryCtx | MutationCtx,
  clerkId: string,
): Promise<Doc<"spaces">[]> {
  const rows = await ctx.db
    .query("spaces")
    .withIndex("by_parent", (q) =>
      q.eq("parentType", "user").eq("parentId", clerkId),
    )
    .collect();
  return rows.filter((space) => !space.archivedAt).sort(byPosition);
}

/** Named "Personal" if one exists, otherwise the first by position. */
export function defaultPersonalSpace(
  spaces: Doc<"spaces">[],
): Doc<"spaces"> | null {
  return spaces.find((space) => space.name === "Personal") ?? spaces[0] ?? null;
}

export async function hasNamedPersonalSpace(
  ctx: QueryCtx | MutationCtx,
  clerkId: string,
): Promise<boolean> {
  const spaces = await listUserSpaces(ctx, clerkId);
  return spaces.some((space) => space.name === "Personal");
}
