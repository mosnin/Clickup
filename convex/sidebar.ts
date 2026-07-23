import { query } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";

// Single query that returns the full sidebar tree. Convex re-runs this on
// every relevant table change, so subscribers get live updates without
// stitching multiple queries.
export const tree = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;

    const subject = identity.subject;

    const personalSpace = await ctx.db
      .query("spaces")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", "user").eq("parentId", subject),
      )
      // .first(), not .unique(): a duplicate personal-space row (webhook +
      // ensureCurrent race) must not take the whole sidebar down.
      .first();

    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userClerkId", subject))
      .collect();

    const workspaceDocs = await Promise.all(
      memberships.map((m) => ctx.db.get(m.workspaceId)),
    );

    async function buildSpaceNode(space: Doc<"spaces">) {
      const folders = await ctx.db
        .query("folders")
        .withIndex("by_space", (q) => q.eq("spaceId", space._id))
        .collect();

      const folderNodes = await Promise.all(
        folders
          .sort((a, b) => a.position - b.position)
          .map(async (folder) => {
            const lists = await ctx.db
              .query("lists")
              .withIndex("by_parent", (q) =>
                q.eq("parentType", "folder").eq("parentId", folder._id),
              )
              .collect();
            return {
              _id: folder._id,
              name: folder.name,
              lists: lists.sort((a, b) => a.position - b.position),
            };
          }),
      );

      const directLists = await ctx.db
        .query("lists")
        .withIndex("by_parent", (q) =>
          q.eq("parentType", "space").eq("parentId", space._id),
        )
        .collect();

      const docs = await ctx.db
        .query("docs")
        .withIndex("by_parent", (q) =>
          q.eq("parentType", "space").eq("parentId", space._id),
        )
        .collect();

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
        folders: folderNodes,
        lists: directLists.sort((a, b) => a.position - b.position),
        docs: docs
          // Subpages live under their parent doc, not as flat tree rows.
          .filter((d) => d.parentDocId === undefined)
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .map((d) => ({
            _id: d._id,
            title: d.title,
          })),
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
      workspaces: workspaceNodes,
      // The current user's Clerk subject ID — handy for client code that
      // needs to address the personal scope (e.g. AI Brain search).
      currentClerkId: subject,
    };
  },
});
