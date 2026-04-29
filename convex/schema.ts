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
      v.literal("viewer"),
    ),
    joinedAt: v.number(),
  })
    .index("by_workspace", ["workspaceId"])
    .index("by_user", ["userClerkId"])
    .index("by_user_and_workspace", ["userClerkId", "workspaceId"]),

  // One row per outstanding workspace invite. Token lives in the URL —
  // anybody with the token + a Pace account can accept. Owner / admin
  // creates and revokes; the invitee accepts.
  invitations: defineTable({
    workspaceId: v.id("workspaces"),
    email: v.string(), // lowercased; not necessarily unique (resend allowed)
    role: v.union(
      v.literal("admin"),
      v.literal("member"),
      v.literal("viewer"),
    ),
    token: v.string(),
    inviterClerkId: v.string(),
    createdAt: v.number(),
    expiresAt: v.number(),
    acceptedAt: v.optional(v.number()),
    acceptedByClerkId: v.optional(v.string()),
    revokedAt: v.optional(v.number()),
  })
    .index("by_workspace", ["workspaceId"])
    .index("by_token", ["token"]),

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
    // Soft-delete: when set, the folder + everything beneath are hidden
    // from queries but kept around for the trash window. Cleared by
    // restore; permanently removed by the daily purge cron after 30d.
    deletedAt: v.optional(v.number()),
  })
    .index("by_space", ["spaceId"]),

  lists: defineTable({
    name: v.string(),
    color: v.optional(v.string()),
    parentType: v.union(v.literal("space"), v.literal("folder")),
    parentId: v.string(),
    position: v.number(),
    createdAt: v.number(),
    deletedAt: v.optional(v.number()),
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
    // When set, completing this task spawns a fresh task on the same list
    // with its dates advanced by the chosen interval. The new task copies
    // the same recurrence so the cycle continues.
    recurrence: v.optional(
      v.union(
        v.literal("daily"),
        v.literal("weekly"),
        v.literal("monthly"),
      ),
    ),
    createdByClerkId: v.string(),
    position: v.number(),
    createdAt: v.number(),
    completedAt: v.optional(v.number()),
    deletedAt: v.optional(v.number()),
  })
    .index("by_list", ["listId"])
    .index("by_list_and_status", ["listId", "statusId"])
    .index("by_parent_task", ["parentTaskId"]),

  // External integrations attached to a workspace. Each kind stores its
  // own credential shape inside `config` (e.g. { webhookUrl } for Slack).
  // We deliberately keep this simple — one row per (workspace, kind) —
  // and read it inline from notification flows.
  integrations: defineTable({
    workspaceId: v.id("workspaces"),
    kind: v.literal("slack"),
    enabled: v.boolean(),
    config: v.object({
      webhookUrl: v.string(),
    }),
    createdByClerkId: v.string(),
    createdAt: v.number(),
  })
    .index("by_workspace", ["workspaceId"])
    .index("by_workspace_and_kind", ["workspaceId", "kind"]),

  // Per-list automation rules. Triggered inside tasks.create and
  // tasks.update — kept simple and event-driven (no scheduled jobs yet).
  // Each rule is a single (trigger, action) pair; users compose multiple
  // rules to model anything more complex.
  listAutomations: defineTable({
    listId: v.id("lists"),
    trigger: v.union(
      v.literal("task_created"),
      v.literal("status_changed_to_complete"),
    ),
    action: v.union(
      v.object({
        kind: v.literal("assign_user"),
        clerkId: v.string(),
      }),
      v.object({
        kind: v.literal("set_priority"),
        priority: v.union(
          v.literal("urgent"),
          v.literal("high"),
          v.literal("normal"),
          v.literal("low"),
        ),
      }),
      v.object({
        kind: v.literal("set_status"),
        statusId: v.id("listStatuses"),
      }),
      v.object({
        kind: v.literal("set_due_in_days"),
        days: v.number(),
      }),
    ),
    enabled: v.boolean(),
    createdAt: v.number(),
  }).index("by_list", ["listId"]),

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
    deletedAt: v.optional(v.number()),
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
    deletedAt: v.optional(v.number()),
  }).index("by_parent", ["parentType", "parentId"]),

  // One row per time-tracked interval. `endedAt` undefined means the
  // timer is currently running. Convex doesn't index undefined easily,
  // so the "find running entry for user X" query filters in JS — the
  // working set per user is tiny (typically 0 or 1 row).
  timeEntries: defineTable({
    taskId: v.id("tasks"),
    userClerkId: v.string(),
    startedAt: v.number(),
    endedAt: v.optional(v.number()),
    durationMs: v.optional(v.number()),
    description: v.optional(v.string()),
    billable: v.boolean(),
    createdAt: v.number(),
  })
    .index("by_task", ["taskId"])
    .index("by_user", ["userClerkId"])
    .index("by_user_started", ["userClerkId", "startedAt"]),

  // Vector embeddings indexed for semantic search ("Brain"). Each row
  // points at a primary entity (doc, task, or message) and carries the
  // OpenAI text-embedding-3-small vector (1536 dims). `scopeType` /
  // `scopeId` mirror the visibility rules so vector search filters never
  // leak across boundaries.
  embeddings: defineTable({
    parentType: v.union(
      v.literal("doc"),
      v.literal("task"),
      v.literal("message"),
    ),
    parentId: v.string(),
    scopeType: v.union(v.literal("user"), v.literal("workspace")),
    scopeId: v.string(),
    textPreview: v.string(),
    embedding: v.array(v.float64()),
    updatedAt: v.number(),
  })
    .index("by_parent", ["parentType", "parentId"])
    .vectorIndex("by_embedding", {
      vectorField: "embedding",
      dimensions: 1536,
      filterFields: ["scopeType", "scopeId"],
    }),

  // Short screen+voice recordings ("Clips") attached to a task.
  // Bytes live in Convex file storage; we keep a metadata row per clip
  // pointing at the storage id so we can list/delete clips and look up
  // the playback URL via ctx.storage.getUrl.
  clips: defineTable({
    parentType: v.literal("task"),
    parentId: v.string(),
    authorClerkId: v.string(),
    storageId: v.id("_storage"),
    durationMs: v.optional(v.number()),
    mimeType: v.optional(v.string()),
    sizeBytes: v.optional(v.number()),
    createdAt: v.number(),
  }).index("by_parent", ["parentType", "parentId"]),

  // Goals support three target shapes — numerical, money, and
  // true/false. The wire shape is the same for all three: a target
  // and current value plus an optional unit (e.g. "USD" for money).
  // Boolean goals store currentValue as 0 or 1 against a target of 1.
  goals: defineTable({
    parentType: v.union(v.literal("user"), v.literal("workspace")),
    parentId: v.string(),
    title: v.string(),
    description: v.optional(v.string()),
    targetType: v.union(
      v.literal("number"),
      v.literal("money"),
      v.literal("boolean"),
    ),
    targetValue: v.number(),
    currentValue: v.number(),
    unit: v.optional(v.string()),
    dueDate: v.optional(v.number()),
    status: v.union(
      v.literal("open"),
      v.literal("complete"),
      v.literal("abandoned"),
    ),
    ownerClerkId: v.string(),
    createdAt: v.number(),
    completedAt: v.optional(v.number()),
  }).index("by_parent", ["parentType", "parentId"]),
});
