import { query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { defaultPersonalSpace, listUserSpaces } from "./_userSpaces";

function byPosition(
  a: { position: number; createdAt: number },
  b: { position: number; createdAt: number },
): number {
  return a.position - b.position || a.createdAt - b.createdAt;
}

// Single query that returns the full sidebar tree. Convex re-runs this on
// every relevant table change, so subscribers get live updates without
// stitching multiple queries.
export const tree = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;

    const subject = identity.subject;

    const userSpaces = await listUserSpaces(ctx, subject);
    const personalSpace = defaultPersonalSpace(userSpaces);

    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userClerkId", subject))
      .collect();

    const workspaceDocs = await Promise.all(
      memberships.map((m) => ctx.db.get(m.workspaceId)),
    );

    async function buildSpaceNode(space: Doc<"spaces">) {
      const projects = await ctx.db
        .query("projects")
        .withIndex("by_space", (q) => q.eq("spaceId", space._id))
        .collect();

      // Ordering rule (mirrored on the Space page): projects first, then
      // space-direct lists — each by position with a createdAt tiebreak so
      // rows never shuffle when two siblings share a position.
      const projectNodes = await Promise.all(
        projects
          .sort(byPosition)
          .map(async (project) => {
            const lists = await ctx.db
              .query("lists")
              .withIndex("by_parent", (q) =>
                q.eq("parentType", "project").eq("parentId", project._id),
              )
              .collect();
            return {
              _id: project._id,
              name: project.name,
              position: project.position,
              color: project.color,
              projectStatus: project.projectStatus,
              // Carried so the roadmap panel can tell assigned projects
              // from unassigned ones without a second round trip.
              roadmapId: project.roadmapId,
              lists: lists.sort(byPosition),
            };
          }),
      );

      const directLists = await ctx.db
        .query("lists")
        .withIndex("by_parent", (q) =>
          q.eq("parentType", "space").eq("parentId", space._id),
        )
        .collect();

      // Pages attached to this space. A page lives in a scope and shows up
      // wherever it is attached, so the tree reads them through attachments
      // rather than owning them — one object, one mapping, two views of it.
      const pageAttachments = await ctx.db
        .query("pageAttachments")
        .withIndex("by_target", (q) =>
          q.eq("targetType", "space").eq("targetId", space._id),
        )
        .collect();
      const pages: { _id: Id<"pages">; title: string; pinned: boolean }[] = [];
      for (const att of pageAttachments) {
        const page = await ctx.db.get(att.pageId);
        if (!page || page.archivedAt !== undefined) continue;
        // Subpages hang off their parent page, not as flat tree rows.
        if (page.parentPageId !== undefined) continue;
        pages.push({
          _id: page._id,
          title: page.title,
          pinned: att.pinned === true,
        });
      }

      const whiteboards = await ctx.db
        .query("whiteboards")
        .withIndex("by_parent", (q) =>
          q.eq("parentType", "space").eq("parentId", space._id),
        )
        .collect();

      return {
        _id: space._id,
        name: space.name,
        color: space.color,
        private: space.private ?? false,
        // The scope a page created from this space belongs to. Carried on the
        // node so the sidebar can create one without a second lookup.
        scopeType: space.parentType,
        scopeId: space.parentId,
        projects: projectNodes,
        lists: directLists.sort(byPosition),
        pages: pages.sort((a, b) => {
          // Canonical context first: it is the page someone opening the space
          // most likely came for.
          if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
          return a.title.localeCompare(b.title);
        }),
        whiteboards: whiteboards
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .map((w) => ({ _id: w._id, title: w.title })),
      };
    }

    const workspaceNodes = await Promise.all(
      workspaceDocs
        .filter((w): w is NonNullable<typeof w> => w !== null)
        .map(async (workspace) => {
          const spaces = await ctx.db
            .query("spaces")
            .withIndex("by_parent", (q) =>
              q.eq("parentType", "workspace").eq("parentId", workspace._id),
            )
            .collect();
          // Archived spaces leave the sidebar; private spaces only appear
          // to the creator, listed members, and the workspace owner.
          const ownerClerkId = workspace.ownerClerkId;
          const visible = spaces.filter((sp) => {
            if (sp.archivedAt) return false;
            if (!sp.private) return true;
            return (
              sp.createdByClerkId === subject ||
              (sp.memberClerkIds ?? []).includes(subject) ||
              ownerClerkId === subject
            );
          });
          const spaceNodes = await Promise.all(
            visible
              .sort((a, b) => a.position - b.position)
              .map(buildSpaceNode),
          );
          const membership = memberships.find(
            (m) => m.workspaceId === workspace._id,
          );
          return {
            _id: workspace._id,
            name: workspace.name,
            slug: workspace.slug,
            role: membership?.role ?? "member",
            spaces: spaceNodes,
          };
        }),
    );

    return {
      personal: personalSpace ? await buildSpaceNode(personalSpace) : null,
      // Every user-scoped space (Personal + company spaces). `personal` stays
      // the default for /dashboard/personal and older clients.
      personalSpaces: await Promise.all(userSpaces.map(buildSpaceNode)),
      workspaces: workspaceNodes,
      // The current user's Clerk subject ID — handy for client code that
      // needs to address the personal scope (e.g. AI Brain search).
      currentClerkId: subject,
    };
  },
});
