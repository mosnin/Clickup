import type { QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { canAccessSpace } from "./_authz";

// Walking a scope, once.
//
// Lifted out of uiComponents.ts so the data-stream resolver and the legacy
// component resolver share exactly one definition of "every list this person
// can see inside this scope". Two copies of a visibility walk is two places to
// forget an access check, and the check is the whole point: a panel is a query
// somebody else may have written and must never read across a boundary its
// author could not cross.

/** Every list inside a scope the caller may actually see. */
export async function listsInScope(
  ctx: QueryCtx,
  scopeType: "user" | "workspace",
  scopeId: string,
): Promise<Doc<"lists">[]> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return [];

  const spaces = await ctx.db
    .query("spaces")
    .withIndex("by_parent", (q) =>
      q.eq("parentType", scopeType).eq("parentId", scopeId),
    )
    .collect();

  const out: Doc<"lists">[] = [];
  for (const space of spaces) {
    if (space.archivedAt) continue;
    if (!(await canAccessSpace(ctx, space, identity))) continue;

    out.push(
      ...(await ctx.db
        .query("lists")
        .withIndex("by_parent", (q) =>
          q.eq("parentType", "space").eq("parentId", space._id),
        )
        .collect()),
    );
    const projects = await ctx.db
      .query("projects")
      .withIndex("by_space", (q) => q.eq("spaceId", space._id))
      .collect();
    for (const project of projects) {
      out.push(
        ...(await ctx.db
          .query("lists")
          .withIndex("by_parent", (q) =>
            q.eq("parentType", "project").eq("parentId", project._id),
          )
          .collect()),
      );
    }
  }
  return out;
}
