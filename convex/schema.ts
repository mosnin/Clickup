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
// Customization (phase 2):
//   - Each List owns its own set of statuses and custom fields.
//   - `tasks.statusId` references a `listStatuses` row in the same list.
//   - Custom field values live in `taskFieldValues`, keyed by (task, field).
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
    parentType: v.union(v.literal("space"), v.literal("folder")),
    parentId: v.string(),
    position: v.number(),
    createdAt: v.number(),
  })
    .index("by_parent", ["parentType", "parentId"]),

  // Per-list custom workflow stages. Every list seeds 4 defaults
  // (To Do / In Progress / Complete / Closed) on creation; users can
  // rename, recolor, add, or delete them.
  //
  // `category` keeps a coarse grouping so the UI can still answer
  // "is this task complete?" without hardcoding status names.
  listStatuses: defineTable({
    listId: v.id("lists"),
    name: v.string(),
    color: v.string(),
    category: v.union(
      v.literal("open"),
      v.literal("in_progress"),
      v.literal("complete"),
      v.literal("closed"),
    ),
    position: v.number(),
    createdAt: v.number(),
  }).index("by_list", ["listId"]),

  // Per-list field definitions (one row per column the user adds).
  customFields: defineTable({
    listId: v.id("lists"),
    name: v.string(),
    type: v.union(
      v.literal("text"),
      v.literal("number"),
      v.literal("dropdown"),
      v.literal("date"),
      v.literal("checkbox"),
    ),
    // Only set for `type === "dropdown"`.
    options: v.optional(
      v.array(
        v.object({
          id: v.string(),
          label: v.string(),
          color: v.optional(v.string()),
        }),
      ),
    ),
    position: v.number(),
    createdAt: v.number(),
  }).index("by_list", ["listId"]),

  // Sparse value rows: one per (task, field) pair that has a value set.
  // The four optional `*Value` columns let each row hold the right
  // primitive without packing JSON. Dropdown stores its option id in
  // `textValue`.
  taskFieldValues: defineTable({
    taskId: v.id("tasks"),
    fieldId: v.id("customFields"),
    textValue: v.optional(v.string()),
    numberValue: v.optional(v.number()),
    booleanValue: v.optional(v.boolean()),
    dateValue: v.optional(v.number()),
  })
    .index("by_task", ["taskId"])
    .index("by_field", ["fieldId"])
    .index("by_task_and_field", ["taskId", "fieldId"]),

  tasks: defineTable({
    listId: v.id("lists"),
    title: v.string(),
    description: v.optional(v.string()),
    statusId: v.id("listStatuses"),
    priority: v.optional(
      v.union(
        v.literal("urgent"),
        v.literal("high"),
        v.literal("normal"),
        v.literal("low"),
      ),
    ),
    startDate: v.optional(v.number()),
    dueDate: v.optional(v.number()),
    assigneeClerkIds: v.array(v.string()),
    parentTaskId: v.optional(v.id("tasks")),
    createdByClerkId: v.string(),
    position: v.number(),
    createdAt: v.number(),
    completedAt: v.optional(v.number()),
  })
    .index("by_list", ["listId"])
    .index("by_list_and_status", ["listId", "statusId"])
    .index("by_parent_task", ["parentTaskId"]),

  // Threaded messages used both for task comments and Space/Workspace chat.
  // The parent is polymorphic so the same composer + renderer powers all
  // three contexts.
  //
  // `body` is plain text containing optional `@[Name](clerkId)` mention
  // tokens. The composer + renderer parse those tokens into pills.
  // For each token we also write a row in `mentions` so unread lookups
  // are constant-time.
  messages: defineTable({
    parentType: v.union(
      v.literal("task"),
      v.literal("space"),
      v.literal("workspace"),
    ),
    parentId: v.string(),
    authorClerkId: v.string(),
    body: v.string(),
    // Top-level message has no parentMessageId. Replies point at the root
    // message so we can render a flat thread under each top-level message.
    parentMessageId: v.optional(v.id("messages")),
    // "Assigned comment": when set, this message is a TODO targeted at
    // someone — they (or anyone) can resolve it.
    assigneeClerkId: v.optional(v.string()),
    resolvedAt: v.optional(v.number()),
    resolvedByClerkId: v.optional(v.string()),
    editedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_parent", ["parentType", "parentId"])
    .index("by_parent_message", ["parentMessageId"]),

  mentions: defineTable({
    messageId: v.id("messages"),
    mentionedClerkId: v.string(),
    // Materialized so the inbox query doesn't have to walk back through
    // the message + parent + workspace chain for every unread mention.
    parentType: v.union(
      v.literal("task"),
      v.literal("space"),
      v.literal("workspace"),
    ),
    parentId: v.string(),
    readAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_user", ["mentionedClerkId"])
    .index("by_message", ["messageId"]),

  // Rich-text documents. Belong to a workspace, a space, or a personal
  // user (same `parentType` discriminant pattern as spaces). `content`
  // is Tiptap/ProseMirror JSON.
  docs: defineTable({
    parentType: v.union(
      v.literal("user"),
      v.literal("workspace"),
      v.literal("space"),
    ),
    parentId: v.string(),
    title: v.string(),
    content: v.any(),
    createdByClerkId: v.string(),
    updatedAt: v.number(),
    createdAt: v.number(),
  }).index("by_parent", ["parentType", "parentId"]),

  // Whiteboards backed by tldraw. `snapshot` is the tldraw store snapshot.
  whiteboards: defineTable({
    parentType: v.union(
      v.literal("user"),
      v.literal("workspace"),
      v.literal("space"),
    ),
    parentId: v.string(),
    title: v.string(),
    snapshot: v.optional(v.any()),
    createdByClerkId: v.string(),
    updatedAt: v.number(),
    createdAt: v.number(),
  }).index("by_parent", ["parentType", "parentId"]),
});
