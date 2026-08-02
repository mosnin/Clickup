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
  return await walk(ctx, scopeType, scopeId, identity);
}

/**
 * Every list inside a scope, with no per-space visibility check.
 *
 * **The caller must narrow the result to something it has already
 * authorized.** There is exactly one: grading an expectation, which runs on a
 * cron with no identity and immediately restricts to the project the decision
 * was made in.
 *
 * That restriction is why this is safe rather than a hole, and it is also the
 * better product rule: a claim attached to a decision should be about the
 * thing the decision was about. Measuring it across a whole workspace would
 * both leak private spaces into an aggregate and let the number move for
 * reasons nobody claimed anything about.
 */
export async function allListsInScope(
  ctx: QueryCtx,
  scopeType: "user" | "workspace",
  scopeId: string,
): Promise<Doc<"lists">[]> {
  return await walk(ctx, scopeType, scopeId, null);
}

/**
 * Every list inside a scope that a NAMED person may see.
 *
 * The same walk `listsInScope` does, with the identity supplied instead of
 * read from the request. A cron has no ambient identity, and the two existing
 * options are both wrong for a subscription someone owns: `listsInScope`
 * silently returns nothing (no identity → no lists → every task situation
 * measures zero, and zero is permanently `at_most`), while `allListsInScope`
 * skips the per-space check and would let a subscription read private spaces
 * its owner cannot open.
 *
 * So the rule is the ordinary one, asked on behalf of the owner: a situation
 * sees exactly what the person who subscribed to it sees, and nothing more.
 * Callers must confirm separately that the owner still has the scope — this
 * walks spaces, and a revoked workspace membership is a fact above them.
 */
export async function listsInScopeAs(
  ctx: QueryCtx,
  scopeType: "user" | "workspace",
  scopeId: string,
  subject: string,
): Promise<Doc<"lists">[]> {
  return await walk(ctx, scopeType, scopeId, { subject });
}

async function walk(
  ctx: QueryCtx,
  scopeType: "user" | "workspace",
  scopeId: string,
  identity: { subject: string } | null,
): Promise<Doc<"lists">[]> {

  const spaces = await ctx.db
    .query("spaces")
    .withIndex("by_parent", (q) =>
      q.eq("parentType", scopeType).eq("parentId", scopeId),
    )
    .collect();

  const out: Doc<"lists">[] = [];
  for (const space of spaces) {
    if (space.archivedAt) continue;
    if (identity && !(await canAccessSpace(ctx, space, identity))) continue;

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
