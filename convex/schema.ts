import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// Schema for the ClickUp clone.
//
// Identity model:
//   - Clerk owns auth. We mirror users into `users` via the Clerk webhook
//     (see convex/http.ts) so server functions can reference internal user
//     records by Clerk subject ID.
//
// Hierarchy (matches ClickUp):
//   Workspace (team) ─┐
//                     ├─ Space ─ Folder? ─ List ─ Task ─ Subtask
//   User (personal) ──┘
//
//   - Every user has exactly one personal Space (created on the first
//     `user.created` webhook).
//   - Team Workspaces hold many Spaces, one membership row per user.
//   - `lists` and `spaces` use a discriminated parent (parentType+parentId)
//     because Convex doesn't support union-of-Id field types.
//
// Authorization is enforced inside each query/mutation via the helpers in
// convex/_authz.ts — every read/write that touches a list/task/folder/space
// resolves up the chain to a workspace+membership or a personal-space owner.
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
    position: v.number(),
    createdAt: v.number(),
  })
    .index("by_parent", ["parentType", "parentId"]),

  folders: defineTable({
    name: v.string(),
    spaceId: v.id("spaces"),
    position: v.number(),
    createdAt: v.number(),
  })
    .index("by_space", ["spaceId"]),

  lists: defineTable({
    name: v.string(),
    color: v.optional(v.string()),
    // Lists can sit directly under a Space, or be grouped inside a Folder.
    parentType: v.union(v.literal("space"), v.literal("folder")),
    parentId: v.string(), // Id<"spaces"> or Id<"folders"> serialized
    position: v.number(),
    createdAt: v.number(),
  })
    .index("by_parent", ["parentType", "parentId"]),

  tasks: defineTable({
    listId: v.id("lists"),
    title: v.string(),
    description: v.optional(v.string()),
    status: v.union(
      v.literal("open"),
      v.literal("in_progress"),
      v.literal("complete"),
      v.literal("closed"),
    ),
    priority: v.optional(
      v.union(
        v.literal("urgent"),
        v.literal("high"),
        v.literal("normal"),
        v.literal("low"),
      ),
    ),
    dueDate: v.optional(v.number()),
    assigneeClerkIds: v.array(v.string()),
    // Subtasks: a task whose parentTaskId points at another task in the
    // same list. Top-level tasks have parentTaskId undefined.
    parentTaskId: v.optional(v.id("tasks")),
    createdByClerkId: v.string(),
    position: v.number(),
    createdAt: v.number(),
    completedAt: v.optional(v.number()),
  })
    .index("by_list", ["listId"])
    .index("by_list_and_status", ["listId", "status"])
    .index("by_parent_task", ["parentTaskId"]),
});
