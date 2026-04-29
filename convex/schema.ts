import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// Schema for the ClickUp clone.
//
// Identity model:
//   - Clerk owns auth. We mirror users into `users` via the Clerk webhook
//     (see app/api/webhooks/clerk/route.ts) so server functions can
//     reference internal user records by Clerk subject ID.
//
// Workspace model:
//   - Every user has exactly one personal space (created at first login).
//   - Users can additionally belong to many team `workspaces`. Membership
//     is tracked in `memberships` so we can query by either side.
//   - `spaces` are top-level containers and belong to either a user
//     (parentType: "user") or a workspace (parentType: "workspace").
//     This mirrors ClickUp's "Spaces" inside a Workspace.
export default defineSchema({
  users: defineTable({
    clerkId: v.string(),
    email: v.string(),
    name: v.optional(v.string()),
    imageUrl: v.optional(v.string()),
    onboardedAt: v.optional(v.number()),
  })
    .index("by_clerk_id", ["clerkId"])
    .index("by_email", ["email"]),

  workspaces: defineTable({
    name: v.string(),
    slug: v.string(),
    ownerClerkId: v.string(),
    createdAt: v.number(),
  })
    .index("by_owner", ["ownerClerkId"])
    .index("by_slug", ["slug"]),

  memberships: defineTable({
    workspaceId: v.id("workspaces"),
    userClerkId: v.string(),
    role: v.union(
      v.literal("owner"),
      v.literal("admin"),
      v.literal("member"),
    ),
    joinedAt: v.number(),
  })
    .index("by_workspace", ["workspaceId"])
    .index("by_user", ["userClerkId"])
    .index("by_user_and_workspace", ["userClerkId", "workspaceId"]),

  spaces: defineTable({
    name: v.string(),
    color: v.optional(v.string()),
    parentType: v.union(v.literal("user"), v.literal("workspace")),
    // For parentType "user", parentId is the Clerk subject ID.
    // For parentType "workspace", parentId is the Convex workspace ID
    // serialized as a string (Convex doesn't support union over Id types).
    parentId: v.string(),
    createdAt: v.number(),
  })
    .index("by_parent", ["parentType", "parentId"]),
});
