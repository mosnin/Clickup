import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { buzzTables } from "./buzz/_tables";
import { buzzNotificationTables } from "./buzz/notifications";
import { buzzReminderTables } from "./buzz/reminders";
import { buzzModerationTables } from "./buzz/moderation";
import { buzzWorkflowTables } from "./buzz/workflows";
import { buzzBridgeTables } from "./buzz/bridge";

// Schema for operate.to.
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
    // Synced from Clerk's primary email record. OAuth UserInfo only reports
    // `email_verified: true` when the identity provider actually verified it.
    emailVerified: v.optional(v.boolean()),
    name: v.optional(v.string()),
    imageUrl: v.optional(v.string()),
    onboardedAt: v.optional(v.number()),
    // Platform-admin account controls. A suspended user is blocked from
    // every authenticated operation (Clerk via _authz.requireIdentity, and
    // agent API keys via _agentAuth.requireAgentByKey — a hold that only
    // stops humans leaves the fleet running).
    suspendedAt: v.optional(v.number()),
    suspendedReason: v.optional(v.string()),
  })
    .index("by_clerk_id", ["clerkId"])
    .index("by_email", ["email"]),

  workspaces: defineTable({
    name: v.string(),
    slug: v.string(),
    ownerClerkId: v.string(),
    createdAt: v.number(),
    // Owner-controlled autonomy boundary. Missing means the conservative
    // supervised defaults so existing workspaces never gain authority from
    // a schema migration alone.
    executionPolicy: v.optional(
      v.object({
        mode: v.union(
          v.literal("supervised"),
          v.literal("bounded_autonomous"),
        ),
        version: v.number(),
        maxPlanTasks: v.number(),
        maxTasksPerWave: v.number(),
        dailyTaskLimit: v.number(),
        updatedByClerkId: v.string(),
        updatedAt: v.number(),
      }),
    ),
    // Platform-admin control: a suspended workspace's members lose access.
    suspendedAt: v.optional(v.number()),
    suspendedReason: v.optional(v.string()),
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
    // ── ClickUp-style Space identity + governance ──
    description: v.optional(v.string()),
    // Private: visible only to the creator, the listed members, and the
    // workspace owner (so a departing member can't strand content).
    // Enforced in _authz.canAccessSpace for every human read/write that
    // resolves through the hierarchy. Personal spaces are private by nature.
    private: v.optional(v.boolean()),
    memberClerkIds: v.optional(v.array(v.string())),
    createdByClerkId: v.optional(v.string()),
    // Archived spaces disappear from the sidebar/home but keep their data;
    // un-archive from space settings.
    archivedAt: v.optional(v.number()),
    /**
     * How this space looks, for everyone in it.
     *
     * A sparse appearance patch restricted to the "place" keys — accent,
     * radius, surface. Personal keys (type size, motion, density, sidebar
     * position) are dropped when this is resolved, so a space can give itself
     * an identity without being able to change how anyone reads.
     *
     * `v.any()` for the same reason `uiPreferences.appearance` is: the design
     * system grows levers, and a row written by a newer build must degrade
     * rather than fail validation.
     */
    theme: v.optional(v.any()),
    /**
     * How this space draws its panels — src/lib/component-style.ts. Unlike
     * `theme`, a space may set every key here: none of them is an
     * accessibility setting, they are all about how one panel is drawn.
     */
    componentStyle: v.optional(v.any()),
    // ClickApps-style feature toggles: when a key is explicitly false the
    // matching surface hides for this space's lists (UI-gated; data stays).
    features: v.optional(
      v.object({
        sprints: v.optional(v.boolean()),
        timeTracking: v.optional(v.boolean()),
        goals: v.optional(v.boolean()),
        whiteboards: v.optional(v.boolean()),
      }),
    ),
    // Default workflow statuses for NEW lists created in this space.
    // When unset, lists seed the global 4 defaults.
    defaultStatuses: v.optional(
      v.array(
        v.object({
          name: v.string(),
          color: v.string(),
          category: v.union(
            v.literal("open"),
            v.literal("in_progress"),
            v.literal("complete"),
            v.literal("closed"),
          ),
        }),
      ),
    ),
  })
    .index("by_parent", ["parentType", "parentId"]),

  // Deprecated: superseded by `projects` below. Kept declared only so the
  // one-shot migration in migrations.ts can read the rows it converts —
  // Convex refuses to validate documents in a table the schema omits, so
  // this cannot be deleted until the migration has run everywhere and the
  // table is empty.
  folders: defineTable({
    name: v.string(),
    spaceId: v.id("spaces"),
    position: v.number(),
    createdAt: v.number(),
  })
    .index("by_space", ["spaceId"]),

  // ── Projects ──
  // The layer between a Space and its Lists: Workspace → Space → Project →
  // List → Task. A project is the unit of work people talk about ("the
  // billing migration"); a list is one board of tasks inside it. This
  // replaces `folders`, which was the same shape with none of the meaning —
  // and it takes over the project identity that used to be bolted onto
  // `lists` back when a list *was* a project.
  projects: defineTable({
    name: v.string(),
    spaceId: v.id("spaces"),
    position: v.number(),
    createdAt: v.number(),
    color: v.optional(v.string()),
    // One-line summary shown on Home cards and the project header.
    description: v.optional(v.string()),
    // Health signal, set by the owner; drives status chips everywhere.
    projectStatus: v.optional(
      v.union(
        v.literal("on_track"),
        v.literal("at_risk"),
        v.literal("off_track"),
        v.literal("paused"),
      ),
    ),
    // Accountable human (clerkId) or agent (agent doc id) — actor id shape.
    ownerActorId: v.optional(v.string()),
    // Freeform project notes: decisions, links, context. Plain text.
    notes: v.optional(v.string()),
    // Target completion date (local-midnight ms).
    targetDate: v.optional(v.number()),
    // ── Roadmap membership ──
    // A project can sit in one roadmap phase; roadmapPosition orders it
    // within that phase. All optional — projects outside roadmaps are fine.
    roadmapId: v.optional(v.id("roadmaps")),
    roadmapPhaseId: v.optional(v.string()),
    roadmapPosition: v.optional(v.number()),
    archivedAt: v.optional(v.number()),
  })
    .index("by_space", ["spaceId"])
    .index("by_roadmap", ["roadmapId"]),

  lists: defineTable({
    name: v.string(),
    color: v.optional(v.string()),
    // "folder" is legacy and only appears on rows the migration has not
    // reached yet; new lists are parented to a space or a project.
    parentType: v.union(
      v.literal("space"),
      v.literal("folder"),
      v.literal("project"),
    ),
    parentId: v.string(),
    position: v.number(),
    createdAt: v.number(),
    // A list keeps its own blurb ("what this board is for"); the project's
    // description is a different sentence and lives on the project.
    description: v.optional(v.string()),
    // ── Deprecated: project identity moved to `projects` ──
    // The migration copies these onto the owning project and clears them.
    // Declared until then because Convex validates every stored field.
    roadmapId: v.optional(v.id("roadmaps")),
    roadmapPhaseId: v.optional(v.string()),
    roadmapPosition: v.optional(v.number()),
    projectStatus: v.optional(
      v.union(
        v.literal("on_track"),
        v.literal("at_risk"),
        v.literal("off_track"),
        v.literal("paused"),
      ),
    ),
    ownerActorId: v.optional(v.string()),
    notes: v.optional(v.string()),
    targetDate: v.optional(v.number()),
    // ── Operations (Phase L) ──
    // Assignment routing: tasks created WITHOUT an explicit assignee get
    // one automatically. fixed = every listed assignee; round_robin =
    // next in rotation (lastIndex is the cursor); least_loaded = whoever
    // has the fewest open tasks on this list. Explicit assignees always
    // win — routing only fills silence.
    routing: v.optional(
      v.object({
        mode: v.union(
          v.literal("fixed"),
          v.literal("round_robin"),
          v.literal("least_loaded"),
        ),
        assigneeIds: v.array(v.string()),
        lastIndex: v.optional(v.number()),
      }),
    ),
    // How much a claim means on this list.
    //
    // "advisory" (the default, and the behaviour every list had) is correct
    // where people and agents share work: a claim says "I am on this", and
    // nothing is refused. It is wrong for a queue several workers pull from
    // concurrently, where two writers is the normal case rather than the
    // unlucky one — and the platform could not express the difference.
    //
    // "required" gives the existing claim teeth on the lists that ask for it.
    // No locking subsystem; see updateTaskCore for the rule, including why a
    // human writing to an unclaimed task takes the claim rather than being
    // refused.
    claimPolicy: v.optional(
      v.union(v.literal("advisory"), v.literal("required")),
    ),
    // Attached SOP: slug of a skill (built-in or custom, resolved per
    // scope). Travels with every task read over MCP so agents get the
    // procedure alongside the work.
    sopSlug: v.optional(v.string()),
    // The view this project opens in when no ?view= is in the URL.
    defaultView: v.optional(
      v.union(
        v.literal("list"),
        v.literal("board"),
        v.literal("calendar"),
        v.literal("gantt"),
        v.literal("table"),
        v.literal("workload"),
      ),
    ),
  })
    .index("by_parent", ["parentType", "parentId"])
    .index("by_roadmap", ["roadmapId"]),

  // ── Roadmaps (Phase K) ──
  // Workspace-level phased containers ("Now / Next / Later", quarters,
  // launch trains…) that projects slot into. Phases are embedded: small,
  // ordered, and always fetched with the roadmap.
  roadmaps: defineTable({
    workspaceId: v.id("workspaces"),
    name: v.string(),
    description: v.optional(v.string()),
    phases: v.array(
      v.object({
        id: v.string(),
        name: v.string(),
        // Optional phase target (local-midnight ms) for timeline framing.
        targetDate: v.optional(v.number()),
      }),
    ),
    position: v.number(),
    createdAt: v.number(),
  }).index("by_workspace", ["workspaceId"]),

  // ── Milestones (per project) ──
  // Named, dated checkpoints INSIDE one project (list): "Beta cut",
  // "Design freeze". Tasks join a milestone via tasks.milestoneId, so a
  // milestone's progress derives from its tasks' statuses (see
  // milestones.ts) rather than being tracked by hand. Deleting a milestone
  // only clears the link — it never deletes tasks.
  milestones: defineTable({
    listId: v.id("lists"),
    name: v.string(),
    description: v.optional(v.string()),
    // Local-midnight ms, same convention as lists.targetDate.
    targetDate: v.optional(v.number()),
    position: v.number(),
    status: v.union(v.literal("open"), v.literal("complete")),
    completedAt: v.optional(v.number()),
    // clerkId (human) or agent document id — the actor pattern's id shape.
    createdByActorId: v.string(),
    createdAt: v.number(),
  }).index("by_list", ["listId"]),

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
    // Kanban WIP limit for this column. Advisory: the Board highlights a
    // column over its limit rather than refusing the drop — matching the
    // task-claim philosophy (signal, don't block).
    wipLimit: v.optional(v.number()),
    position: v.number(),
    createdAt: v.number(),
  }).index("by_list", ["listId"]),

  // Per-list field definitions (one row per column the user adds).
  //
  // The type union is the full ClickUp-parity set. Everything type-specific
  // beyond the option list lives in `config`, so adding a type never means
  // adding another top-level column. Validation for every type — of both the
  // definition and each value written against it — lives in
  // convex/_customFields.ts and is shared by the human mutations and the
  // key-authenticated agent API.
  customFields: defineTable({
    listId: v.id("lists"),
    name: v.string(),
    type: v.union(
      // Basic
      v.literal("text"),
      v.literal("long_text"),
      v.literal("dropdown"),
      v.literal("labels"),
      v.literal("date"),
      v.literal("checkbox"),
      v.literal("files"),
      // Numeric
      v.literal("number"),
      v.literal("money"),
      v.literal("rating"),
      v.literal("progress"),
      v.literal("voting"),
      // Contact
      v.literal("email"),
      v.literal("phone"),
      v.literal("url"),
      v.literal("location"),
      // Relational
      v.literal("people"),
      v.literal("relationship"),
      // Computed (derived on read, never written)
      v.literal("rollup"),
      v.literal("formula"),
    ),
    // Only set for `type === "dropdown"` and `type === "labels"`.
    options: v.optional(
      v.array(
        v.object({
          id: v.string(),
          label: v.string(),
          color: v.optional(v.string()),
        }),
      ),
    ),
    // Per-type configuration. Only the keys a given type uses are stored.
    config: v.optional(
      v.object({
        // money: ISO 4217 code. number/money: decimal places.
        currency: v.optional(v.string()),
        precision: v.optional(v.number()),
        // number: inclusive bounds.
        min: v.optional(v.number()),
        max: v.optional(v.number()),
        // rating: how many stars (2–10, default 5).
        ratingMax: v.optional(v.number()),
        // people/relationship: allow more than one entry (default true).
        multiple: v.optional(v.boolean()),
        // relationship: the list linked tasks must come from.
        relationListId: v.optional(v.id("lists")),
        // formula: an arithmetic expression over other numeric fields on
        // this list, referenced as {Field name}. Parsed by a hand-rolled
        // recursive-descent parser — never eval'd.
        formula: v.optional(v.string()),
        // rollup: derive a number from subtasks or from the tasks a
        // relationship field links to.
        rollup: v.optional(
          v.object({
            source: v.union(
              v.literal("subtasks"),
              v.literal("relationship"),
            ),
            op: v.union(
              v.literal("sum"),
              v.literal("avg"),
              v.literal("count"),
            ),
            sourceFieldId: v.optional(v.id("customFields")),
            relationFieldId: v.optional(v.id("customFields")),
          }),
        ),
      }),
    ),
    position: v.number(),
    createdAt: v.number(),
  }).index("by_list", ["listId"]),

  // Sparse value rows: one per (task, field) pair that has a value set.
  // Each optional column lets a row hold the right shape without packing
  // JSON. Dropdown stores its option id in `textValue`; labels store option
  // ids in `optionIds`; people and voting store principal ids (clerkId or
  // agent doc id) in `actorIds`; relationship stores linked task ids.
  // Computed types (rollup/formula) never have a row — their value is
  // derived on read by computeDerivedValues().
  taskFieldValues: defineTable({
    taskId: v.id("tasks"),
    fieldId: v.id("customFields"),
    textValue: v.optional(v.string()),
    numberValue: v.optional(v.number()),
    booleanValue: v.optional(v.boolean()),
    dateValue: v.optional(v.number()),
    // ISO 4217 code stored alongside a money amount.
    currency: v.optional(v.string()),
    optionIds: v.optional(v.array(v.string())),
    actorIds: v.optional(v.array(v.string())),
    taskIds: v.optional(v.array(v.id("tasks"))),
    location: v.optional(
      v.object({
        label: v.string(),
        lat: v.optional(v.number()),
        lng: v.optional(v.number()),
      }),
    ),
    files: v.optional(
      v.array(
        v.object({
          storageId: v.id("_storage"),
          name: v.string(),
          mimeType: v.string(),
          sizeBytes: v.number(),
        }),
      ),
    ),
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
    // Explicit execution contract used by capability-aware routing. Agents
    // may only claim tasks whose complete requirement set they advertise.
    requiredCapabilities: v.optional(v.array(v.string())),
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
    // Phase 12 — agent collaboration:
    //   - sprintId groups tasks into a sprint (see `sprints`).
    //   - blockedByTaskIds are hard dependencies; agents refuse to complete
    //     a task while a blocker is still open.
    //   - claimedByActorId is a soft work-lock (a clerkId or an agent id)
    //     so two agents don't pick up the same task. Claims expire via
    //     claimedAt so a crashed agent can't hold a task forever.
    //   - checklist holds lightweight acceptance criteria that agents (and
    //     humans) can tick off one by one.
    sprintId: v.optional(v.id("sprints")),
    blockedByTaskIds: v.optional(v.array(v.id("tasks"))),
    claimedByActorId: v.optional(v.string()),
    claimedAt: v.optional(v.number()),
    checklist: v.optional(
      v.array(
        v.object({
          id: v.string(),
          text: v.string(),
          done: v.boolean(),
        }),
      ),
    ),
    // Human-in-the-loop gate: when true, agents cannot move this task
    // into a complete-category status until a human calls tasks.approve
    // (humans completing directly counts as approval).
    requiresApproval: v.optional(v.boolean()),
    approvedByClerkId: v.optional(v.string()),
    approvedAt: v.optional(v.number()),
    // Phase F — scrum planning:
    //   - estimatePoints: story-point estimate; sums drive sprint capacity
    //     bars, points-based velocity, and workload balancing.
    //   - milestone: marks a date-anchored deliverable; Gantt/timeline
    //     render it as a diamond marker instead of a duration bar.
    estimatePoints: v.optional(v.number()),
    milestone: v.optional(v.boolean()),
    // Membership in one of this project's dated checkpoints (see the
    // `milestones` table). Distinct from the `milestone` boolean above,
    // which flags a task as being a date-anchored deliverable itself.
    milestoneId: v.optional(v.id("milestones")),
    // Set by the watchdog when it emits task.overdue, so each task nags
    // at most once per overdue period.
    overdueNotifiedAt: v.optional(v.number()),
    // Dedupe for the due-soon reminder (one nudge per due date).
    dueSoonNotifiedAt: v.optional(v.number()),
    // ── Thrash (P11) ──
    //
    // Set together by the watchdog when a task has been failed at repeatedly.
    // `thrashHeldAt` is the BRAKE, not the notice: while it is set the task is
    // withheld from next_task, because detection with no brake is a
    // notification and the loop it detected carries on burning budget
    // regardless. A human clears it (tasks.clearThrashHold), and completing
    // the task clears it too — a loop that resolved itself needs no ceremony.
    // `thrashNotifiedAt` is the dedupe: the watchdog runs every fifteen
    // minutes and a detector that re-announced a standing condition would file
    // the same row ninety times a day.
    thrashHeldAt: v.optional(v.number()),
    thrashNotifiedAt: v.optional(v.number()),
    thrashFailures: v.optional(v.number()),
    // Why the hold is on. Two passes raise the same brake for two different
    // reasons — a task being failed at over and over, and a dispatched attempt
    // that ran out of retries — and a person clearing the queue needs to know
    // which, because the fix is different. Kept on the ONE hold field rather
    // than growing a second parallel mechanism: two flags that both mean
    // "withheld until somebody looks" is how the two drift.
    holdReason: v.optional(
      v.union(v.literal("thrash"), v.literal("attempts_exhausted")),
    ),
    createdByClerkId: v.string(),
    position: v.number(),
    createdAt: v.number(),
    completedAt: v.optional(v.number()),
  })
    // The held-task range. An absent optional field sorts before every number,
    // so `> 0` is exactly the set that has been held — the same trick the
    // claimed-tasks and due-tasks passes use, and the reason neither of them
    // is a table scan.
    .index("by_thrash_held", ["thrashHeldAt"])
    .index("by_list", ["listId"])
    .index("by_list_and_status", ["listId", "statusId"])
    .index("by_parent_task", ["parentTaskId"])
    .index("by_sprint", ["sprintId"])
    .index("by_milestone", ["milestoneId"])
    // Watchdog ranges: claimed tasks are claimedByActorId > "" (absent
    // fields sort before all strings); due tasks are 0 < dueDate < now.
    .index("by_claimed", ["claimedByActorId"])
    .index("by_due", ["dueDate"])
    // The global set of approval-gated tasks (small) for the inbox queue.
    .index("by_approval", ["requiresApproval"]),

  // Versioned source-of-truth briefs shared by every human and agent
  // working in a project. A packet is deliberately list-scoped: the list
  // is both the access boundary and the project whose conventions it
  // describes. Attachments let one packet travel with many tasks without
  // copying markdown that would immediately drift.
  contextPackets: defineTable({
    listId: v.id("lists"),
    title: v.string(),
    summary: v.optional(v.string()),
    content: v.string(),
    version: v.number(),
    createdByActorId: v.string(),
    createdAt: v.number(),
    updatedByActorId: v.string(),
    updatedAt: v.number(),
  }).index("by_list", ["listId"]),

  taskContextPackets: defineTable({
    taskId: v.id("tasks"),
    packetId: v.id("contextPackets"),
    attachedByActorId: v.string(),
    attachedAt: v.number(),
  })
    .index("by_task", ["taskId"])
    .index("by_packet", ["packetId"])
    .index("by_task_and_packet", ["taskId", "packetId"]),

  // Proof that a specific agent read the exact packet version attached to
  // a task. Updating a packet makes older receipts stale automatically;
  // claim/complete gates then force the agent to reload before proceeding.
  agentContextReceipts: defineTable({
    agentId: v.id("agents"),
    taskId: v.id("tasks"),
    packetId: v.id("contextPackets"),
    version: v.number(),
    acknowledgedAt: v.number(),
  })
    .index("by_task", ["taskId"])
    .index("by_packet", ["packetId"])
    .index("by_agent_task", ["agentId", "taskId"])
    .index("by_agent_task_packet", ["agentId", "taskId", "packetId"]),

  // Immutable operating-policy versions. A stable key (for example
  // "launch.region") identifies one decision chain; superseding creates a
  // new row and only links the old row forward, preserving the exact words
  // and rationale every task originally relied on.
  decisions: defineTable({
    listId: v.id("lists"),
    key: v.string(),
    version: v.number(),
    title: v.string(),
    statement: v.string(),
    rationale: v.string(),
    status: v.union(
      v.literal("active"),
      v.literal("superseded"),
      v.literal("revoked"),
    ),
    supersedesDecisionId: v.optional(v.id("decisions")),
    supersededByDecisionId: v.optional(v.id("decisions")),
    contextPacketId: v.optional(v.id("contextPackets")),
    createdByActorType: v.union(
      v.literal("user"),
      v.literal("agent"),
      v.literal("system"),
    ),
    createdByActorId: v.string(),
    createdAt: v.number(),
  })
    .index("by_list", ["listId", "createdAt"])
    .index("by_list_and_key", ["listId", "key", "version"]),

  // A decision change is not considered absorbed merely because it exists.
  // Each affected task gets an explicit impact assessment. Pending and
  // rework-required rows gate agent execution; completed tasks remain in
  // this table so post-completion revalidation cannot disappear.
  decisionImpacts: defineTable({
    decisionId: v.id("decisions"),
    taskId: v.id("tasks"),
    status: v.union(
      v.literal("pending"),
      v.literal("no_change"),
      v.literal("rework_required"),
      v.literal("resolved"),
    ),
    assessedByActorType: v.optional(
      v.union(
        v.literal("user"),
        v.literal("agent"),
        v.literal("system"),
      ),
    ),
    assessedByActorId: v.optional(v.string()),
    note: v.optional(v.string()),
    assessedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_decision", ["decisionId"])
    .index("by_task", ["taskId", "createdAt"])
    .index("by_decision_and_task", ["decisionId", "taskId"]),

  // Immutable provenance for a plan compiled from one conversation/brief
  // into a roadmap, projects, tasks, dependencies, assignments, and
  // versioned context. The original source and explicit assumptions stay
  // beside the generated artifact ids so humans and agents can audit why
  // the execution graph exists. `idempotencyKey` makes retries safe.
  executionPlans: defineTable({
    workspaceId: v.id("workspaces"),
    spaceId: v.id("spaces"),
    createdByAgentId: v.id("agents"),
    idempotencyKey: v.string(),
    requestFingerprint: v.string(),
    name: v.string(),
    objective: v.string(),
    sourceContext: v.string(),
    successCriteria: v.array(v.string()),
    assumptions: v.array(v.string()),
    openQuestions: v.array(v.string()),
    // New plans require a human owner/admin decision before agents may
    // dispatch them. Undefined is reserved for plans created before this
    // control existed and is treated as legacy-approved.
    reviewStatus: v.optional(
      v.union(
        v.literal("pending"),
        v.literal("approved"),
        v.literal("rejected"),
      ),
    ),
    authorizationSource: v.optional(
      v.union(
        v.literal("human_review"),
        v.literal("workspace_policy"),
      ),
    ),
    // Policy-authorized plans are valid only while this exact workspace
    // policy version remains active. Human approval does not depend on it.
    authorizationPolicyVersion: v.optional(v.number()),
    authorizationReason: v.optional(v.string()),
    roadmapId: v.id("roadmaps"),
    projects: v.array(
      v.object({
        ref: v.string(),
        name: v.string(),
        listId: v.id("lists"),
        phaseId: v.string(),
        contextPacketId: v.id("contextPackets"),
      }),
    ),
    tasks: v.array(
      v.object({
        ref: v.string(),
        title: v.string(),
        taskId: v.id("tasks"),
        listId: v.id("lists"),
      }),
    ),
    // Incremented whenever new source context is appended across every
    // workstream packet. The original manifest stays immutable; revisions
    // live in executionPlanRevisions and force re-review.
    contextRevision: v.optional(v.number()),
    lastContextRevisionAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_workspace", ["workspaceId", "createdAt"])
    .index("by_agent_key", ["createdByAgentId", "idempotencyKey"]),

  // Append-only amendments to the source conversation behind an execution
  // plan. One revision updates every generated context packet in the same
  // transaction, making prior agent acknowledgements stale automatically.
  executionPlanRevisions: defineTable({
    planId: v.id("executionPlans"),
    revision: v.number(),
    idempotencyKey: v.string(),
    requestFingerprint: v.string(),
    changeSummary: v.string(),
    sourceAddendum: v.string(),
    createdByAgentId: v.id("agents"),
    affectedPacketCount: v.number(),
    affectedTaskCount: v.number(),
    createdAt: v.number(),
  })
    .index("by_plan", ["planId", "revision"])
    .index("by_plan_key", ["planId", "idempotencyKey"]),

  // Append-only authorization history. Re-reviewing a plan creates another
  // row instead of overwriting the evidence behind an earlier decision.
  executionPlanReviews: defineTable({
    planId: v.id("executionPlans"),
    decision: v.union(v.literal("approved"), v.literal("rejected")),
    note: v.string(),
    reviewedByClerkId: v.string(),
    reviewedAt: v.number(),
  }).index("by_plan", ["planId", "reviewedAt"]),

  // Auditable releases of ready work from an execution plan to real agent
  // runtimes. A short lease prevents repeated dispatch storms; expired,
  // unclaimed work becomes eligible for a later recovery wave.
  executionWaves: defineTable({
    workspaceId: v.id("workspaces"),
    planId: v.id("executionPlans"),
    createdByAgentId: v.id("agents"),
    idempotencyKey: v.string(),
    requestFingerprint: v.string(),
    openQuestionDisposition: v.optional(v.string()),
    authorizationSource: v.optional(
      v.union(
        v.literal("legacy"),
        v.literal("human_review"),
        v.literal("workspace_policy"),
      ),
    ),
    authorizationPolicyVersion: v.optional(v.number()),
    assignments: v.array(
      v.object({
        taskId: v.id("tasks"),
        taskRef: v.string(),
        agentId: v.id("agents"),
        delivery: v.union(
          v.literal("notify_url"),
          v.literal("poll_required"),
        ),
        contextPacketCount: v.optional(v.number()),
        estimatedContextTokens: v.optional(v.number()),
        contextVersionFingerprint: v.optional(v.string()),
      }),
    ),
    skipped: v.array(
      v.object({
        taskRef: v.string(),
        reason: v.string(),
      }),
    ),
    createdAt: v.number(),
  })
    .index("by_plan", ["planId", "createdAt"])
    .index("by_workspace", ["workspaceId", "createdAt"])
    .index("by_agent_key", ["createdByAgentId", "idempotencyKey"]),

  // Mutable lifecycle receipt for every immutable wave assignment. This is
  // the execution control plane: it proves whether dispatched work was
  // claimed, actually started, finished with evidence, failed, or was
  // abandoned and made safe to retry.
  executionAssignments: defineTable({
    workspaceId: v.id("workspaces"),
    planId: v.id("executionPlans"),
    waveId: v.id("executionWaves"),
    taskId: v.id("tasks"),
    taskRef: v.string(),
    agentId: v.id("agents"),
    delivery: v.union(
      v.literal("notify_url"),
      v.literal("poll_required"),
    ),
    contextPacketCount: v.optional(v.number()),
    estimatedContextTokens: v.optional(v.number()),
    contextVersionFingerprint: v.optional(v.string()),
    status: v.union(
      v.literal("dispatched"),
      v.literal("claimed"),
      v.literal("running"),
      v.literal("succeeded"),
      v.literal("failed"),
      v.literal("abandoned"),
    ),
    attempt: v.number(),
    runId: v.optional(v.id("agentRuns")),
    dispatchedAt: v.number(),
    claimedAt: v.optional(v.number()),
    startedAt: v.optional(v.number()),
    lastHeartbeatAt: v.optional(v.number()),
    finishedAt: v.optional(v.number()),
    summary: v.optional(v.string()),
    error: v.optional(v.string()),
    links: v.optional(v.array(v.string())),
    // When the recovery pass last handed this task back to the pull path.
    //
    // Separate from `finishedAt` on purpose: that says when the ATTEMPT ended
    // and is the honest answer to "how long did this run", which re-offering
    // must not overwrite. This is the clock the recovery delay counts from, so
    // a re-offer waits its turn again instead of being eligible immediately.
    lastRecoveredAt: v.optional(v.number()),
  })
    .index("by_plan", ["planId", "dispatchedAt"])
    // The recovery range. Abandonment already happened — the watchdog and
    // reconcile both produce these — but nothing was on the other side, so a
    // stalled attempt sat there until a human or an orchestrator noticed,
    // which is the opposite of unattended operation. This index is what lets
    // the recovery pass find them without walking every plan.
    .index("by_status_and_finished", ["status", "finishedAt"])
    .index("by_wave", ["waveId"])
    .index("by_task", ["taskId", "dispatchedAt"])
    .index("by_agent", ["agentId", "dispatchedAt"])
    .index("by_run", ["runId"]),

  // Durable wake delivery for every direct agent notification. A configured
  // notify URL is only a requested channel; this row proves whether the signed
  // ping actually reached the agent runtime after bounded retries.
  agentPingDeliveries: defineTable({
    // Optional for migration compatibility with execution-only receipts
    // created before delivery was generalized.
    scopeType: v.optional(
      v.union(v.literal("user"), v.literal("workspace")),
    ),
    scopeId: v.optional(v.string()),
    workspaceId: v.optional(v.id("workspaces")),
    sourceKind: v.optional(
      v.union(
        v.literal("execution_assignment"),
        v.literal("task_assignment"),
        v.literal("mention"),
        v.literal("revision"),
        // One notice channel for "you are stopped", whoever pulled it — a
        // human, or a budget ceiling. See stopNotice in convex/_agentStop.ts
        // for why the ENFORCEMENT lifetimes differ even though the notice
        // does not.
        v.literal("stop"),
        // "Your finished work was rejected, or the world moved under it."
        // Only the outcomes an agent has to ACT on travel here — an approved
        // effect applied, so the task already says so and a wake-up carrying
        // "the thing you asked for happened" is noise in a channel meant to
        // interrupt. See convex/pendingEffects.ts.
        v.literal("effect_decided"),
      ),
    ),
    sourceId: v.optional(v.string()),
    executionAssignmentId: v.optional(v.id("executionAssignments")),
    agentId: v.id("agents"),
    taskId: v.optional(v.id("tasks")),
    messageId: v.optional(v.id("messages")),
    type: v.string(),
    payload: v.any(),
    status: v.union(
      v.literal("poll_required"),
      v.literal("pending"),
      v.literal("delivered"),
      v.literal("failed"),
    ),
    attempts: v.number(),
    responseStatus: v.optional(v.number()),
    lastError: v.optional(v.string()),
    lastAttemptAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
    // HTTP delivery proves the runtime accepted the wake. This second receipt
    // proves the authenticated target agent consumed it over MCP.
    acknowledgedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_execution_assignment", ["executionAssignmentId"])
    .index("by_source", ["sourceKind", "sourceId"])
    .index("by_agent", ["agentId", "createdAt"])
    .index("by_agent_acknowledged", [
      "agentId",
      "acknowledgedAt",
      "createdAt",
    ])
    .index("by_workspace", ["workspaceId", "createdAt"])
    .index("by_status", ["status", "createdAt"]),

  // Plan-level outcome assurance. Tasks and runs prove that work happened;
  // these rows prove that the original success criteria were independently
  // evaluated against evidence. Older plans are supported without a data
  // migration: missing rows are synthesized as pending and created on the
  // first submission or review.
  outcomeChecks: defineTable({
    planId: v.id("executionPlans"),
    // Evidence is valid only for the source context revision it evaluated.
    // Older rows stay stored for provenance but read as stale after context
    // advances.
    contextRevision: v.optional(v.number()),
    criterionIndex: v.number(),
    criterion: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("submitted"),
      v.literal("passed"),
      v.literal("failed"),
    ),
    submittedByAgentId: v.optional(v.id("agents")),
    evidenceSummary: v.optional(v.string()),
    evidenceLinks: v.optional(v.array(v.string())),
    submittedAt: v.optional(v.number()),
    reviewedByActorType: v.optional(
      v.union(v.literal("user"), v.literal("agent")),
    ),
    reviewedByActorId: v.optional(v.string()),
    reviewNote: v.optional(v.string()),
    reviewedAt: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index("by_plan", ["planId", "criterionIndex"]),

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
      v.literal("channel"),
      // A comment on a page — the discussion *about* the document, kept out
      // of the document itself so an agent reading the page gets the decision
      // and not the argument that produced it.
      v.literal("page"),
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
    // Structured references parsed out of the body at write time.
    //
    // The tokens live inline in `body` (that is the source of truth, the same
    // way mentions do), but an agent reading a message over MCP should not
    // have to re-parse prose to learn which project is being discussed — so
    // the resolved set is denormalized here.
    refs: v.optional(
      v.array(
        v.object({
          kind: v.union(
            v.literal("project"),
            v.literal("list"),
            v.literal("task"),
            v.literal("page"),
            v.literal("sprint"),
            v.literal("goal"),
            // C12: the same literal `_refs.REF_KINDS` gained. It has to be here
            // too or a Work message naming a Chat room fails validation on the
            // way in — the refs are parsed from the body, so the vocabulary the
            // parser knows and the vocabulary this column accepts are the same
            // vocabulary.
            v.literal("room"),
          ),
          id: v.string(),
          label: v.string(),
        }),
      ),
    ),
    createdAt: v.number(),
  })
    .index("by_parent", ["parentType", "parentId"])
    .index("by_parent_message", ["parentMessageId"]),

  mentions: defineTable({
    // Absent for mentions that don't come from a comment — a page mention
    // lives in the page's own markdown, so there is no message to point at.
    messageId: v.optional(v.id("messages")),
    mentionedClerkId: v.string(),
    // Materialized so the inbox query doesn't have to walk back through
    // the message + parent + workspace chain for every unread mention.
    parentType: v.union(
      v.literal("task"),
      v.literal("space"),
      v.literal("workspace"),
      v.literal("channel"),
      v.literal("page"),
      // C12, the unified inbox: a Chat room. `parentId` is the room key from
      // `src/lib/buzz/bridge.ts` (scope + channel id) rather than a bare
      // channel id, because a Buzz channel id is unique inside a community and
      // the inbox has no other way to know which community it came from.
      v.literal("room"),
    ),
    parentId: v.string(),
    // Carried on the row for message-less sources, so the inbox still has
    // something to show and someone to attribute it to.
    snippet: v.optional(v.string()),
    byName: v.optional(v.string()),
    readAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_user", ["mentionedClerkId"])
    .index("by_message", ["messageId"])
    // "Is this person already mentioned on this page?" — a page saves every
    // 700ms while someone types, so the write path must be idempotent.
    .index("by_parent", ["parentType", "parentId"]),

  // Rich-text documents. Belong to a workspace, a space, or a personal
  // user (same `parentType` discriminant pattern as spaces). `content`
  // is Tiptap/ProseMirror JSON.
  // DEPRECATED — folded into `pages`. Retained because Convex validates every
  // stored document against the schema, so the table cannot be dropped while
  // rows exist; `migrations.docsToPages` converts them and marks each row
  // `migratedToPageId`. Nothing new should read or write this table.
  docs: defineTable({
    /** Set once this doc has become a page; the row is history after that. */
    migratedToPageId: v.optional(v.id("pages")),
    // Wiki nesting: a doc may live under another doc as a subpage.
    parentDocId: v.optional(v.id("docs")),
    // "list" is a project. A doc attached to a project holds the detailed
    // context an agent needs and a task description has no room for. Same
    // table as space/workspace docs on purpose: one editor, one search index,
    // one authorization path (see requireDocLikeParentAccess).
    parentType: v.union(
      v.literal("user"),
      v.literal("workspace"),
      v.literal("space"),
      v.literal("list"),
    ),
    parentId: v.string(),
    title: v.string(),
    content: v.any(),
    // Marks a project doc as canonical context, so agents are handed it with
    // the task instead of having to know to go looking.
    pinnedContext: v.optional(v.boolean()),
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
  // points at a primary entity (doc or task) and carries the OpenAI
  // text-embedding-3-small vector (1536 dims). `scopeType`/`scopeId`
  // mirror the visibility rules (a personal-space task scopes to the
  // owning user; a workspace task scopes to its workspace) so vector
  // search filters never leak across boundaries.
  embeddings: defineTable({
    parentType: v.union(
      v.literal("doc"),
      v.literal("task"),
      v.literal("page"),
      // Channel messages and task comments — where the arguing happens. Held
      // behind a length floor (convex/_indexable.ts) because indexing every
      // message means an embedding call per "ok".
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


  // ── Pages ──
  // The long-form layer: briefs, specs, decision records, runbooks — the
  // context a task description has no room for and a comment thread buries.
  //
  // Markdown is the source of truth, not a rendering of something else. An
  // agent writes markdown because that is what it writes natively; a person
  // reads it rendered and types into the same bytes. One representation means
  // no lossy conversion step where an agent's edit destroys a human's
  // formatting or the reverse.
  //
  // A page belongs to exactly one scope (a person's own space, or a
  // workspace) — that is the tenancy boundary, and it never moves. Where a
  // page *shows up* is a separate, many-to-many question answered by
  // pageAttachments, so the same architecture note can hang off the project,
  // the list it mostly concerns, and the three tasks that implement it,
  // without being copied.
  pages: defineTable({
    title: v.string(),
    markdown: v.string(),
    scopeType: v.union(v.literal("user"), v.literal("workspace")),
    scopeId: v.string(),
    // Pages nest, the way Notion pages do. Null/absent means top level.
    parentPageId: v.optional(v.id("pages")),
    position: v.number(),
    // clerkId (human) or agent document id — the actor id shape used
    // everywhere else.
    createdByActorId: v.string(),
    createdByName: v.string(),
    updatedByActorId: v.optional(v.string()),
    updatedByName: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    archivedAt: v.optional(v.number()),
    // ── Provenance, for pages that used to be docs ──
    // The original Tiptap JSON is kept, not discarded. Converting someone's
    // writing on a guess is the kind of migration you can't apologise your
    // way out of; keeping the source means an imperfect conversion is a bug
    // to fix rather than data that's gone.
    importedFromDocId: v.optional(v.id("docs")),
    importedDocContent: v.optional(v.any()),
    importedLossless: v.optional(v.boolean()),
  })
    .index("by_scope", ["scopeType", "scopeId"])
    .index("by_parent_page", ["parentPageId"])
    .index("by_imported_doc", ["importedFromDocId"])
    .searchIndex("by_text", {
      searchField: "markdown",
      filterFields: ["scopeType", "scopeId"],
    })
    // Separate from by_text: a Convex search index covers one field, and
    // "the page called X" is the search people actually run.
    .searchIndex("by_title", {
      searchField: "title",
      filterFields: ["scopeType", "scopeId"],
    }),

  // Where a page appears. Deliberately open-ended: a page can be pinned to
  // anything that has a page worth reading next to it.
  pageAttachments: defineTable({
    pageId: v.id("pages"),
    targetType: v.union(
      v.literal("workspace"),
      v.literal("space"),
      v.literal("project"),
      v.literal("list"),
      v.literal("task"),
      v.literal("agent"),
      v.literal("goal"),
      v.literal("sprint"),
    ),
    targetId: v.string(),
    // "This is the canonical context for this work" — the one distinction
    // worth signifying, and the successor to docs.pinnedContext. A pinned
    // page is handed to an agent with the task instead of being something the
    // agent has to know to go looking for.
    pinned: v.optional(v.boolean()),
    createdByActorId: v.string(),
    createdAt: v.number(),
  })
    .index("by_page", ["pageId"])
    .index("by_target", ["targetType", "targetId"])
    .index("by_page_and_target", ["pageId", "targetType", "targetId"]),

  // Who is looking at a page right now.
  //
  // Presence is liveness, not state, so every row carries its own expiry: a
  // client refreshes its row on a timer and readers ignore anything stale.
  // A tab that crashes stops refreshing and simply ages out — which is why
  // this can live in the database at all without leaving ghosts behind.
  // Superseded by `presence` below, which covers every surface and both kinds
  // of principal. Kept declared only so the rows already in flight validate;
  // they age out in 45 seconds and the retention pass drains the remainder, at
  // which point this definition can go.
  pagePresence: defineTable({
    pageId: v.id("pages"),
    actorId: v.string(),
    name: v.string(),
    editing: v.boolean(),
    updatedAt: v.number(),
  })
    .index("by_page", ["pageId"])
    .index("by_page_and_actor", ["pageId", "actorId"]),

  // Who is on a surface right now — people and agents in the same table.
  //
  // One table rather than one per surface, because "who else is here" is the
  // same question everywhere and the alternative is five near-identical
  // implementations that drift. A plain table with a freshness window rather
  // than a realtime service, because Convex already pushes query results to
  // every subscriber: a heartbeat row IS a live feed, with no second system to
  // authenticate or keep in sync.
  //
  // `actorType` is the point of the whole thing. An agent that appears in the
  // same rail as a person, on the surface it is actually working on, is present
  // rather than merely reported somewhere else.
  presence: defineTable({
    surfaceType: v.union(
      v.literal("page"),
      v.literal("task"),
      v.literal("list"),
      v.literal("project"),
      v.literal("space"),
      // A Chat community (`"<scopeType>:<scopeId>"`). The same literal is
      // added to `presence.SURFACE_TYPE`; this union is where it is defined.
      v.literal("community"),
    ),
    surfaceId: v.string(),
    /** clerkId for a person, agent document id for an agent. */
    actorId: v.string(),
    actorType: v.union(v.literal("user"), v.literal("agent")),
    name: v.string(),
    /** Writing rather than reading — what draws a caret instead of a dot. */
    editing: v.boolean(),
    /** In its own words: "drafting the migration section". */
    detail: v.optional(v.string()),
    updatedAt: v.number(),
  })
    .index("by_surface", ["surfaceType", "surfaceId"])
    .index("by_surface_and_actor", ["surfaceType", "surfaceId", "actorId"])
    .index("by_actor", ["actorId"]),

  // Resolved [[wikilinks]] between pages, rewritten on every save. Stored
  // rather than derived so backlinks are an index range instead of a scan of
  // every page's markdown.
  pageLinks: defineTable({
    fromPageId: v.id("pages"),
    toPageId: v.id("pages"),
  })
    .index("by_from", ["fromPageId"])
    .index("by_to", ["toPageId"]),

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
    // ── Phase L: auto-rollup ──
    // When set, progress derives live from the linked list's completed-task
    // rollup on every read; manual setProgress is refused. "Move things
    // forward" becomes visible without anyone logging numbers.
    sourceListId: v.optional(v.id("lists")),
  })
    .index("by_parent", ["parentType", "parentId"])
    .index("by_source", ["sourceListId"]),

  // One person's UI, as data.
  //
  // Per-user rather than per-workspace: how dense you want your rows is a fact
  // about you, not about the team, and it should follow you between
  // workspaces. Stored as one row so a change is one patch and every open tab
  // re-renders from the same Convex subscription — that is what makes this
  // save in real time without a save button.
  uiPreferences: defineTable({
    userClerkId: v.string(),
    /**
     * The appearance settings blob, normalized on read by
     * src/lib/appearance.ts. Deliberately `v.any()`: this shape changes
     * whenever the design system grows a new lever, and a stored row written
     * by an older build must never fail schema validation and lock someone
     * out of their own account.
     */
    appearance: v.any(),
    /**
     * How to read `appearance`.
     *
     * Absent (or 1) means a full eleven-key snapshot, which is what every row
     * written before space themes existed holds. Read literally those rows pin
     * every setting, so a space's look could never reach anyone who had once
     * opened the settings panel — `prunePatch` drops the keys equal to the
     * shipped default to recover what the person actually chose. Version 2
     * rows are already sparse and are taken at face value.
     */
    patchVersion: v.optional(v.number()),
    /**
     * Per-space divergences, keyed by space id: "this space, but for me".
     * Place keys only — the resolver drops anything else, so this can never
     * become a way to have a different font size in one space.
     */
    spaceOverrides: v.optional(v.any()),
    updatedAt: v.number(),
    /**
     * How this person's panels are drawn — src/lib/component-style.ts.
     * A separate field from `appearance` because it answers a different
     * question (what does a panel look like, not what does the app look
     * like) and because a space may set all of it, unlike appearance.
     */
    componentStyle: v.optional(v.any()),
    /** Per-space overrides of the above, keyed by space id. */
    componentStyleBySpace: v.optional(v.any()),
    /**
     * What each panel last showed this person, keyed by widget id.
     *
     * This is what lets a panel answer "what changed since I last looked" —
     * the question every dashboard is asked and none can answer, because a
     * dashboard is pull and has no memory of ever having shown you anything.
     * Necessarily per person: "since *you* last looked" cannot be derived from
     * the data, only from who was looking.
     */
    panelMemory: v.optional(v.any()),
    /** Conditions panels watch for on their own readings, keyed by widget id. */
    panelWatches: v.optional(v.any()),
    /**
     * Per-panel overrides, keyed by the panel's widget id.
     *
     * The most specific layer there is: "this panel, in particular, is a
     * dial." Sparse like the rest — a panel with no entry inherits, which is
     * what lets a change to the space's look still reach it.
     */
    panelStyles: v.optional(v.any()),
}).index("by_user", ["userClerkId"]),

  // A screen someone has composed for themselves.
  //
  // Keyed by `screenKey` ("project:<id>", "space:<id>", …) so this generalises
  // to any surface without a migration — a new customisable screen is a new
  // key, not a new table. Per-user rather than per-project: how you want to
  // read a project is a fact about you, and one person rearranging their view
  // must not rearrange everyone else's.
  screenLayouts: defineTable({
    userClerkId: v.string(),
    screenKey: v.string(),
    /** `{ widgets: [{ id, span }] }`, normalized on read. `v.any()` for the
     *  same reason uiPreferences uses it: a layout written by a newer build
     *  must degrade, never fail validation. */
    layout: v.any(),
    updatedAt: v.number(),
  })
    .index("by_user", ["userClerkId"])
    .index("by_user_and_screen", ["userClerkId", "screenKey"]),

  // What a page used to say.
  //
  // A page autosaves every ~700ms while someone types, so a naive snapshot per
  // write would produce hundreds of near-identical rows for one paragraph.
  // Revisions are therefore *coalesced*: one row per author per window, patched
  // in place while that window is open, so the history reads as "Ada rewrote
  // the migration section" rather than as a keystroke log.
  pageRevisions: defineTable({
    pageId: v.id("pages"),
    /** The page's content *before* the edit this revision closes. */
    title: v.string(),
    markdown: v.string(),
    // clerkId or agent document id — the same actor shape as everywhere else.
    actorId: v.string(),
    actorName: v.string(),
    createdAt: v.number(),
    /** Extended while this author keeps editing inside the coalesce window. */
    updatedAt: v.number(),
  })
    .index("by_page", ["pageId"])
    .index("by_page_and_time", ["pageId", "createdAt"]),

  // A panel somebody authored, rather than one we shipped.
  //
  // The whole point: panels were a hardcoded registry, so "customising the UI"
  // could only mean choosing which of nine to show. A row here is a DEFINITION
  // — what data, filtered how, drawn as what — and a generic renderer turns it
  // into a panel, so adding a kind of panel needs no code. Two people in one
  // workspace can end up looking at applications that don't resemble each other
  // over identical primitives.
  //
  // `definition` is v.any() and validated on read by src/lib/ui-components.ts
  // against a CLOSED vocabulary. That validation is a security boundary, not a
  // formatting step: agents author these, and the answer to "what can an agent
  // put on my screen" has to be "only combinations the normalizer will emit".
  uiComponents: defineTable({
    /** Who authored it — components are personal unless shared to a scope. */
    ownerClerkId: v.string(),
    /** Where it is offered: a workspace or a user's personal space. */
    scopeType: v.union(v.literal("user"), v.literal("workspace")),
    scopeId: v.string(),
    definition: v.any(),
    /** Set when an agent wrote it, so provenance survives on the panel. */
    authoredByAgentId: v.optional(v.id("agents")),
    authoredByName: v.optional(v.string()),
    /**
     * Offered to everyone in the scope rather than kept.
     *
     * Panels are per-person, which is right — a dashboard is a place you
     * stand. But it means a good panel dies with its author and ten people
     * build ten of the same thing. Sharing OFFERS: a shared panel appears in
     * everyone's tray and nobody's screen, so it spreads without ever being
     * a change to somebody else's dashboard. Same consent shape as every
     * other agent→human path here.
     */
    sharedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_owner_and_scope", ["ownerClerkId", "scopeType", "scopeId"])
    .index("by_scope", ["scopeType", "scopeId"]),

  // A panel that is TRUE rather than placed.
  //
  // See `src/lib/situation.ts` for the argument. A screen is a shelf: things
  // put on it stay there. The adaptive alternative — rearranging somebody's
  // screen for them — is rejected everywhere else in this codebase for a good
  // reason. A subscription is the third option: a panel names a condition, and
  // when that condition becomes true the arrival is OFFERED, exactly like an
  // agent's screen proposal.
  //
  // Per person, like layouts and panels, because whether a panel arrives is a
  // consent decision and consent is not collective. Nothing this table drives
  // writes a layout.
  panelSituations: defineTable({
    ownerClerkId: v.string(),
    /** Where the question is asked, and the boundary it may never read past. */
    scopeType: v.union(v.literal("user"), v.literal("workspace")),
    scopeId: v.string(),
    /** The same key `screenLayouts` uses: "project:<id>". */
    screenKey: v.string(),
    /** The widget id the layout would carry — "custom:<id>" or a built-in. */
    panelId: v.string(),
    /**
     * A Situation. `v.any()` for the reason every definition here is: a row
     * written by another build must degrade rather than fail validation — and
     * `normalizeSituation` REFUSES a malformed one rather than repairing it, so
     * degrading means the subscription does nothing.
     */
    situation: v.any(),
    /**
     * The last evaluated state, and the reason this table exists at all.
     *
     * The dead band is asymmetric — a true situation has to travel a whole band
     * back before it goes false — which is only expressible if the previous
     * answer survives between polls. A cron that recomputed from `false` every
     * tick would have no hysteresis whatever the pure function says, and a
     * value sitting on its threshold would flap once every fifteen minutes.
     *
     * Required rather than optional: absence must not read as "was true". A
     * situation nobody has seen has to earn its arrival.
     */
    wasTrue: v.boolean(),
    /** What it measured last, for the announcement. Absent = unreadable. */
    lastValue: v.optional(v.number()),
    lastCheckedAt: v.optional(v.number()),
    becameTrueAt: v.optional(v.number()),
    becameFalseAt: v.optional(v.number()),
    /**
     * The transition this person has already answered.
     *
     * This is what makes "not now" mean something. A dismissal that only lived
     * for a session would put the same banner back on the next sweep, fifteen
     * minutes later, forever — which is not a dismissal, it is a snooze with no
     * end, and it is the single fastest way to teach someone to stop reading
     * their own screen.
     *
     * A stamp rather than a boolean, because the honest unit of dismissal is
     * the OCCURRENCE, not the subscription. Six tasks open today, dismissed;
     * the sprint clears; next week six are open again — that is a new fact
     * about the work and deserves to be said again. Storing the `becameTrueAt`
     * that was answered gets both halves from one field: while the condition
     * holds, the stamp equals the occurrence and nothing is announced; when it
     * goes false and true again, `becameTrueAt` moves past the stamp and the
     * arrival is offered afresh.
     */
    acknowledgedAt: v.optional(v.number()),
    /**
     * How the last arrival was answered, which is what departure means.
     *
     * A panel the reader KEPT is in their layout and stays there when the
     * condition stops holding — see the note in `situations.ts`. A panel that
     * was only ever previewed was never theirs. Absent = never answered.
     */
    resolution: v.optional(
      v.union(v.literal("kept"), v.literal("dismissed")),
    ),
    /** Cron ordering, so the sweep is an index range rather than a scan. */
    nextCheckAt: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_owner_and_screen", ["ownerClerkId", "screenKey"])
    .index("by_owner_screen_and_panel", ["ownerClerkId", "screenKey", "panelId"])
    .index("by_next_check", ["nextCheckAt"]),

  // An agent's suggestion for how a screen could be arranged.
  //
  // Never a mutation of anyone's layout. The naive version of "the UI adapts
  // to the work" is an AI silently rearranging your screen, which violates
  // every stability property that makes an interface learnable. So the agent
  // authors a PROPOSAL — a first-class object with a reason attached — and a
  // person previews it, accepts it, or dismisses it. The same consent shape as
  // task approval gates, pointed at the interface instead of the work.
  // Work an agent finished that a human has not consented to yet.
  //
  // See src/lib/pending-effects.ts for why this exists at all. In short: a
  // gated task used to REFUSE the agent's completion, and because a Convex
  // mutation that throws rolls back everything it wrote, the refusal took the
  // agent's finished work with it. This is that attempt, kept — proposed, not
  // applied, and applied only when a person says so.
  //
  // The gate is unchanged. Nothing here can complete a task; approving does,
  // and only a human can approve.
  pendingEffects: defineTable({
    // The visibility boundary, mirrored from the agent — the same pair
    // agentWallets and embeddings key off, so "everything waiting on me" is an
    // index range per scope rather than a walk over every task in existence.
    scopeType: v.union(v.literal("user"), v.literal("workspace")),
    scopeId: v.string(),
    kind: v.union(v.literal("task.complete")),
    taskId: v.id("tasks"),
    agentId: v.id("agents"),
    /** Denormalized so a decided row still reads correctly if the agent is
     *  deleted — the record of who did the work outlives the principal. */
    agentName: v.string(),
    /** The agent's account of what it did. Required: an effect with no reason
     *  is a change somebody has to reverse-engineer before consenting to it. */
    reason: v.string(),
    /** What the task's status was when the effect was proposed. If it has
     *  moved since, the proposal was made about a different world and applying
     *  it blindly would clobber whatever happened in between. */
    basedOnStatusId: v.id("listStatuses"),
    /** The status to move to on approval — the one the agent asked for. */
    targetStatusId: v.id("listStatuses"),
    state: v.union(
      v.literal("pending"),
      v.literal("approved"),
      v.literal("rejected"),
      v.literal("superseded"),
    ),
    createdAt: v.number(),
    decidedAt: v.optional(v.number()),
    decidedByClerkId: v.optional(v.string()),
    decisionNote: v.optional(v.string()),
  })
    // The queue: everything still pending in a scope, oldest first.
    .index("by_scope_and_state", ["scopeType", "scopeId", "state", "createdAt"])
    // "Does this task already have a proposal in flight?" — the uniqueness a
    // retrying agent must not be able to defeat by calling twice.
    .index("by_task_and_state", ["taskId", "state"])
    .index("by_agent_and_state", ["agentId", "state", "createdAt"]),

  screenProposals: defineTable({
    /** Same key screenLayouts uses: "project:<id>". */
    screenKey: v.string(),
    agentId: v.id("agents"),
    agentName: v.string(),
    /** The proposed ScreenLayout, normalized client-side like every layout. */
    layout: v.any(),
    /** Why — a proposal without a reason is an instruction. */
    reason: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("accepted"),
      v.literal("dismissed"),
    ),
    createdAt: v.number(),
    resolvedAt: v.optional(v.number()),
    resolvedByClerkId: v.optional(v.string()),
  })
    .index("by_screen_and_status", ["screenKey", "status"])
    .index("by_agent", ["agentId"]),

  // An agent proposing a panel that does not exist yet.
  //
  // The step past rearranging: not "show these nine in a different order" but
  // "here is a question your screen isn't asking". An agent that has been
  // watching the work knows which one, and a panel is now a definition rather
  // than code, so it can write one.
  //
  // Same consent shape as a layout proposal, and for the same reason — an
  // interface that changes itself is an interface nobody can learn. The
  // difference is what accepting does: a layout proposal rearranges what you
  // have, this one MINTS a panel, owned by the acceptor, credited to the
  // agent. Consent is per-person because panels and layouts both are.
  panelProposals: defineTable({
    /** Same key screenLayouts uses: "project:<id>". */
    screenKey: v.string(),
    agentId: v.id("agents"),
    agentName: v.string(),
    /** A PanelDef — normalized by the renderer on every read, like all of them. */
    definition: v.any(),
    /** Where the panel is minted on accept: the scope the agent lives in. */
    scopeType: v.union(v.literal("user"), v.literal("workspace")),
    scopeId: v.string(),
    /** Why — a proposal without a reason is an instruction. */
    reason: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("accepted"),
      v.literal("dismissed"),
    ),
    createdAt: v.number(),
    resolvedAt: v.optional(v.number()),
    resolvedByClerkId: v.optional(v.string()),
  })
    .index("by_screen_and_status", ["screenKey", "status"])
    .index("by_agent", ["agentId"]),

  // Deliberation as a place rather than a transcript.
  //
  // See `src/lib/plan.ts` for the argument. In short: thinking currently lives
  // in channels, which are append-only and time-ordered, so the *state* of a
  // deliberation is nowhere — everyone re-derives the same small answer from
  // something enormous, and an agent joining late gets it wrong.
  //
  // Four kinds, closed, because agents write into this and a free-form canvas
  // of boxes is unparseable. Every status is DERIVED from the shape
  // (`planView`) rather than stored, so nothing can be stale about whether a
  // question is settled. Nodes are retracted, never deleted: "we thought X,
  // then learned better" is the most useful thing a plan holds.
  planNodes: defineTable({
    projectId: v.id("projects"),
    /** Denormalized from the project's space, for agent-scope checks. */
    scopeType: v.union(v.literal("user"), v.literal("workspace")),
    scopeId: v.string(),
    kind: v.union(
      v.literal("question"),
      v.literal("option"),
      v.literal("evidence"),
      v.literal("decision"),
    ),
    /** Options and decisions hang off a question; evidence off an option. */
    parentId: v.optional(v.id("planNodes")),
    body: v.string(),
    authorType: v.union(
      v.literal("user"),
      v.literal("agent"),
      v.literal("system"),
    ),
    authorId: v.string(),
    authorName: v.string(),
    createdAt: v.number(),
    /** Questions: a machine may not close this one. */
    needsHuman: v.optional(v.boolean()),
    /** Evidence: which way it cuts. */
    stance: v.optional(
      v.union(v.literal("supports"), v.literal("refutes"), v.literal("neutral")),
    ),
    /** Decisions: which option won, and whether a person has signed off. */
    chosenOptionId: v.optional(v.id("planNodes")),
    acceptedAt: v.optional(v.number()),
    acceptedByClerkId: v.optional(v.string()),
    acceptedByName: v.optional(v.string()),
    /** A link back into the work this node is about. */
    ref: v.optional(v.object({ kind: v.string(), id: v.string() })),
    /**
     * Decisions only: what the decider expected to happen.
     *
     * The claim is stated in the panel vocabulary, so the same resolver that
     * draws a chart grades the decision — nothing new to invent. `baseline`
     * is captured at the instant the claim is made and that is the whole
     * design: a baseline read afterwards already contains the effect, so a
     * retrofitted expectation compares the world to itself and can never be
     * wrong. See `src/lib/calibration.ts`.
     */
    expectation: v.optional(v.any()),
    /** Filled in once, when the horizon passes. */
    outcome: v.optional(
      v.object({
        verdict: v.union(
          v.literal("met"),
          v.literal("missed"),
          v.literal("unevaluable"),
        ),
        value: v.number(),
        checkedAt: v.number(),
      }),
    ),
    /** Denormalized from `expectation.dueAt` so the cron can range on it. */
    expectationDueAt: v.optional(v.number()),
    retractedAt: v.optional(v.number()),
    retractedByName: v.optional(v.string()),
  })
    .index("by_project", ["projectId"])
    // What is due for grading, cheaply. Only decisions carrying a live
    // expectation land in this range.
    .index("by_expectation_due", ["expectationDueAt"])
    .index("by_parent", ["parentId"])
    // "What did we decide about X, anywhere" — a decision outlives the
    // project it was made in, and nobody remembers which one that was.
    .index("by_scope_and_kind", ["scopeType", "scopeId", "kind"]),

  // ── Phase 12: AI agent collaboration ────────────────────────────────

  // First-class AI agent principals. An agent belongs to either a user's
  // personal space or a team workspace, and can do everything a member
  // can inside that boundary (and nothing outside it). Agents show up in
  // assignee pickers, mentions, and comments exactly like human members —
  // anywhere a clerkId-shaped string is stored, an agent's document id
  // can appear instead, with `actorType` fields (or an agents lookup)
  // telling the two apart.
  agents: defineTable({
    name: v.string(),
    description: v.optional(v.string()),
    emoji: v.optional(v.string()),
    color: v.optional(v.string()),
    parentType: v.union(v.literal("user"), v.literal("workspace")),
    parentId: v.string(),
    status: v.union(v.literal("active"), v.literal("paused")),
    // Permission tier. "member" acts like a workspace member; "readonly"
    // can call every read tool but no mutations. When allowedListIds is
    // set, list/task access (read AND write) is further restricted to
    // those lists.
    role: v.optional(v.union(v.literal("member"), v.literal("readonly"))),
    // Normalized capability slugs (for example typescript, research,
    // quality-assurance). Routing matches these against task requirements;
    // an empty set is intentionally not treated as "can do anything."
    capabilities: v.optional(v.array(v.string())),
    // Hard ceiling for simultaneous dispatched/claimed tasks. The execution
    // controller defaults to one when unset.
    maxConcurrentTasks: v.optional(v.number()),
    allowedListIds: v.optional(v.array(v.id("lists"))),
    // Mutations per UTC day before the agent is throttled. Undefined =
    // DEFAULT_DAILY_ACTION_LIMIT (see _agentAuth.ts).
    dailyActionLimit: v.optional(v.number()),
    /**
     * Daily spend ceiling in USD. Absent = uncapped (the shipped default,
     * because a ceiling nobody set must not silently halt a working fleet).
     *
     * The twin of `dailyActionLimit`, and the one that was missing: writes
     * were budgeted while MONEY was only charted, so an agent could burn
     * hundreds of dollars of tokens inside three mutations. Enforced in
     * `_agentAuth.requireAgentByKey`.
     */
    dailySpendUsdLimit: v.optional(v.number()),
    /**
     * A stop pulled by a human, and why.
     *
     * Distinct from `status: "paused"`, which means "this agent is off until
     * further notice". A stop is about the work in flight: drop what you are
     * doing now. It refuses further writes, releases the agent's claims so
     * the work is not held hostage, and reaches the agent over the wake
     * channel rather than waiting to surface as a refusal on its next write.
     *
     * Cleared by a human (`agents.clearStop`). A stop nobody can lift is
     * just a pause with a worse name.
     */
    stopRequestedAt: v.optional(v.number()),
    stopReason: v.optional(v.string()),
    stopRequestedBy: v.optional(v.string()),
    // Direct push endpoint: assignments and mentions POST a small ping
    // here even when the agent has no webhook subscription, so "assign an
    // agent" works out of the box. When notifySecret is set, pings carry
    // an HMAC-SHA256 X-Ping-Signature header.
    notifyUrl: v.optional(v.string()),
    notifySecret: v.optional(v.string()),
    // Fleet membership (see agentGrants). Exactly one of these is set on any
    // agent that is part of a fleet, and they are deliberately separate
    // fields: an orchestrator HOLDS a grant (may provision) while a worker
    // was PRODUCED BY one (is revoked with it). Collapsing them into one
    // column would make "revoke the fleet" ambiguous about the orchestrator.
    provisionedByGrantId: v.optional(v.id("agentGrants")),
    createdByClerkId: v.string(),
    // Live presence over MCP. lastSeenAt remains the compatibility rollup
    // used for the green dot; the two source timestamps make diagnostics
    // truthful: transport authentication proves connectivity, while an
    // explicit heartbeat proves the runtime is actively following the
    // collaboration protocol.
    lastSeenAt: v.optional(v.number()),
    lastConnectedAt: v.optional(v.number()),
    lastHeartbeatAt: v.optional(v.number()),
    currentTaskId: v.optional(v.id("tasks")),
    statusText: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_parent", ["parentType", "parentId"])
    // Revoking a fleet is an index range over its members, not a scan of
    // every agent in the scope.
    .index("by_grant", ["provisionedByGrantId"]),

  // One row per (agent, UTC day) counting mutations, for the daily action
  // budget. Cheap: single indexed read + patch per agent mutation.
  agentUsage: defineTable({
    agentId: v.id("agents"),
    day: v.string(), // "YYYY-MM-DD" UTC
    count: v.number(),
    // Sliding burst window: mutations in the current minute.
    minute: v.optional(v.string()), // "YYYY-MM-DDTHH:MM" UTC
    minuteCount: v.optional(v.number()),
    /** Self-reported USD spent by this agent on this UTC day. */
    spendUsd: v.optional(v.number()),
  }).index("by_agent_day", ["agentId", "day"]),

  // Structured work sessions ("runs") agents report over MCP: started X,
  // finished with success/failure + summary. Errors reported outside a
  // run land here too as instant failed runs. Powers the per-agent
  // history on the agent detail page and agent.error events.
  agentRuns: defineTable({
    agentId: v.id("agents"),
    taskId: v.optional(v.id("tasks")),
    executionAssignmentId: v.optional(v.id("executionAssignments")),
    title: v.string(),
    status: v.union(
      v.literal("running"),
      v.literal("succeeded"),
      v.literal("failed"),
      v.literal("abandoned"),
    ),
    summary: v.optional(v.string()),
    error: v.optional(v.string()),
    // Artifacts + cost reported by the runtime with finish_run: links to
    // PRs/docs/deploys produced, and what the run cost.
    links: v.optional(v.array(v.string())),
    tokensUsed: v.optional(v.number()),
    costUsd: v.optional(v.number()),
    startedAt: v.number(),
    finishedAt: v.optional(v.number()),
    // ── The live half (AG-UI-shaped) ──
    //
    // A run used to be two bookends: start_run, then finish_run with a
    // summary. Everything between was invisible, which is exactly the part a
    // person watching wants. These fields make the run document itself the
    // stream — Convex pushes every patch to subscribers, so emitting a step is
    // publishing it, with no second transport.
    /** The run's story so far: bounded, ordered, keyed steps. */
    steps: v.optional(
      v.array(
        v.object({
          key: v.string(),
          title: v.string(),
          status: v.union(
            v.literal("running"),
            v.literal("done"),
            v.literal("failed"),
          ),
          detail: v.optional(v.string()),
          startedAt: v.number(),
          finishedAt: v.optional(v.number()),
        }),
      ),
    ),
    /** Small structured state the UI renders live (tests passed, files touched). */
    liveState: v.optional(v.any()),
    /** The agent's current sentence — one line, replaced, never a transcript. */
    lastNarration: v.optional(v.string()),
    narratedAt: v.optional(v.number()),
  })
    .index("by_agent", ["agentId"])
    .index("by_task", ["taskId"]),

  // API keys for agents. We store only a SHA-256 hash — the plaintext key
  // is shown once at creation time. `keyPrefix` keeps the first characters
  // for display ("cua_3f9c…"). Lookup is by hash, so auth is a single
  // indexed read.
  agentKeys: defineTable({
    agentId: v.id("agents"),
    keyHash: v.string(),
    keyPrefix: v.string(),
    createdAt: v.number(),
    revokedAt: v.optional(v.number()),
    lastUsedAt: v.optional(v.number()),
  })
    .index("by_agent", ["agentId"])
    .index("by_hash", ["keyHash"]),

  // OAuth 2.1 authorization for public MCP hosts (ChatGPT, Claude, and
  // standards-compliant clients). Clients are dynamically registered,
  // authorization codes require PKCE, and access/refresh credentials are
  // stored only as hashes.
  oauthClients: defineTable({
    clientId: v.string(),
    clientName: v.string(),
    redirectUris: v.array(v.string()),
    tokenEndpointAuthMethod: v.literal("none"),
    grantTypes: v.array(v.string()),
    createdAt: v.number(),
  }).index("by_client_id", ["clientId"]),

  oauthAuthorizationCodes: defineTable({
    codeHash: v.string(),
    clientId: v.string(),
    redirectUri: v.string(),
    codeChallenge: v.string(),
    scopes: v.array(v.string()),
    // RFC 8707 audience binding. The token endpoint must receive the same
    // canonical protected-resource identifier that was authorized.
    resource: v.optional(v.string()),
    agentId: v.id("agents"),
    userClerkId: v.string(),
    expiresAt: v.number(),
    usedAt: v.optional(v.number()),
    createdAt: v.number(),
  }).index("by_code_hash", ["codeHash"]),

  oauthAccessTokens: defineTable({
    tokenHash: v.string(),
    refreshTokenHash: v.string(),
    clientId: v.string(),
    scopes: v.array(v.string()),
    resource: v.optional(v.string()),
    agentId: v.id("agents"),
    userClerkId: v.string(),
    expiresAt: v.number(),
    refreshExpiresAt: v.number(),
    createdAt: v.number(),
    lastUsedAt: v.optional(v.number()),
    revokedAt: v.optional(v.number()),
  })
    .index("by_token_hash", ["tokenHash"])
    .index("by_refresh_hash", ["refreshTokenHash"])
    .index("by_agent", ["agentId"]),

  // Fleet provisioning grants — one human approval, many agents.
  //
  // Approving agents one at a time does not survive contact with a real
  // fleet: twenty agents is twenty clicks, and a person clicking Approve
  // twenty times is not consenting, they are dismissing a dialog. A grant
  // moves the unit of consent from the agent to the FLEET: a human says
  // "this orchestrator may run up to N workers in this space, none stronger
  // than this", once, and the orchestrator provisions them itself.
  //
  // The envelope is a ceiling, never a default: every provision intersects
  // with it (see _envelope.ts), so nothing under a grant can hold a power
  // the human did not hand over. Revoking the grant revokes the whole fleet
  // in one act, which is the other half of why this is safer than N
  // individually-approved agents — those have N separate off switches.
  agentGrants: defineTable({
    parentType: v.union(v.literal("user"), v.literal("workspace")),
    parentId: v.string(),
    // The agent allowed to provision with this grant. Its own key is the
    // credential, so there is no second token type to steal or rotate.
    holderAgentId: v.id("agents"),
    // Self-reported client of the orchestrator, for the audit trail.
    clientName: v.string(),
    // The envelope. Mirrors _envelope.ts Envelope.
    role: v.union(v.literal("member"), v.literal("readonly")),
    allowedListIds: v.optional(v.array(v.id("lists"))),
    dailyActionLimit: v.number(),
    maxAgents: v.number(),
    grantedByClerkId: v.string(),
    // Revocation is a timestamp rather than a delete: the fleet that existed
    // is part of the audit record, and a deleted grant would orphan the
    // agents that point at it.
    revokedAt: v.optional(v.number()),
    revokedByClerkId: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_scope", ["parentType", "parentId"])
    .index("by_holder", ["holderAgentId"]),

  // What a workspace's navigation looks like before anybody personalises it.
  //
  // The product's claim is that you shape it around your company. That claim
  // is empty if every new member of a marketing team still arrives to Sprints
  // and Roadmaps in the nav — "they don't have to use them" is not the same
  // as "they don't have to see them", and an unused destination on the one
  // strip everybody reads all day is exactly the clutter the product exists
  // to remove.
  //
  // Deliberately a DEFAULT rather than a policy: an admin omitting something
  // means "most of us don't need this", not "you may not have it". Access is
  // decided by the Convex functions, never by whether a link is drawn — see
  // resolveNav, where an unlisted item is still reachable until the person
  // themselves puts it away.
  navDefaults: defineTable({
    parentType: v.union(v.literal("user"), v.literal("workspace")),
    parentId: v.string(),
    /** `{ widgets: [{ id }], hidden: [id] }` — normalized on read, like
     *  screenLayouts, so a row from a newer build degrades rather than
     *  failing validation. */
    layout: v.any(),
    updatedByClerkId: v.string(),
    updatedAt: v.number(),
  }).index("by_parent", ["parentType", "parentId"]),

  // Generic fixed-window rate limiting (see _rateLimit.ts). One row per
  // distinct caller-and-budget, reused across windows rather than inserted
  // per hit — a table that grows per request is the thing being defended
  // against. Pruned by the daily cron once a row goes cold.
  rateLimits: defineTable({
    // "<rule name>:<subject>" — subject is an IP or a Clerk subject.
    key: v.string(),
    window: v.number(),
    count: v.number(),
    updatedAt: v.number(),
  })
    .index("by_key", ["key"])
    .index("by_updated", ["updatedAt"]),

  // OAuth 2.0 Device Authorization Grant (RFC 8628) — how an agent with no
  // browser gets connected. The agent asks for a code, prints it, and a
  // human types it at /link, signs in, and says what the agent may do. The
  // API key is minted at the moment the poller collects it and returned
  // exactly once, so it never renders on a screen and never enters a
  // clipboard or a chat transcript.
  //
  // The device code is stored as a SHA-256 hash for the same reason
  // agentKeys is: reading the database must not be enough to impersonate
  // the agent. The user code is stored in the clear on purpose — it is the
  // lookup key a human types, it authorizes nothing on its own, and
  // approval is bound to the typist's Clerk session.
  agentAuthRequests: defineTable({
    deviceCodeHash: v.string(),
    // WXYA-3479. Uppercase, no ambiguous glyphs (see DEVICE_CODE_ALPHABET).
    userCode: v.string(),
    // Self-reported by the agent runtime, shown on the consent screen so
    // the human knows what they are approving. Untrusted display text.
    clientName: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("approved"),
      v.literal("denied"),
      // Key issued. Terminal: a replayed device code gets invalid_grant.
      v.literal("claimed"),
    ),
    approvedByClerkId: v.optional(v.string()),
    agentId: v.optional(v.id("agents")),
    // Whether approval created the agent, so the poller can tell the human
    // "I made you an agent called X" rather than staying silent about it.
    agentCreated: v.optional(v.boolean()),
    // Rate limiting per RFC 8628 §3.5: a poller faster than the advertised
    // interval gets slow_down, and the interval it must respect grows.
    lastPolledAt: v.optional(v.number()),
    pollIntervalSec: v.number(),
    expiresAt: v.number(),
    createdAt: v.number(),
  })
    .index("by_user_code", ["userCode"])
    .index("by_device_hash", ["deviceCodeHash"])
    // Retention: expired rows are pruned by the daily cron.
    .index("by_expires", ["expiresAt"]),

  // Append-only activity log. Every meaningful mutation (task created,
  // status changed, comment posted, sprint started, …) writes one row.
  // It powers three things: the human-facing activity feed, agent cursor
  // polling (events.since), and outbound webhook fan-out.
  events: defineTable({
    scopeType: v.union(v.literal("user"), v.literal("workspace")),
    scopeId: v.string(),
    type: v.string(),
    actorType: v.union(
      v.literal("user"),
      v.literal("agent"),
      v.literal("system"),
    ),
    actorId: v.string(),
    actorName: v.string(),
    entityType: v.string(),
    entityId: v.string(),
    entityTitle: v.optional(v.string()),
    // Optional listId lets webhook subscriptions filter to a single list.
    listId: v.optional(v.id("lists")),
    payload: v.optional(v.any()),
    createdAt: v.number(),
  })
    .index("by_scope", ["scopeType", "scopeId", "createdAt"])
    .index("by_actor", ["actorType", "actorId"]),

  // Topic threads for agent↔agent (and agent↔human) discussion that
  // shouldn't pollute the main workspace chat. Messages attach with
  // parentType "channel".
  channels: defineTable({
    scopeType: v.union(v.literal("user"), v.literal("workspace")),
    scopeId: v.string(),
    name: v.string(),
    // What the channel is for, shown under its name. Optional because a
    // channel created by an agent mid-conversation shouldn't be blocked on
    // writing a description first.
    topic: v.optional(v.string()),
    createdByActorId: v.string(),
    createdAt: v.number(),
    // Denormalized so the channel rail can sort by activity and show a
    // preview without reading every channel's messages.
    lastMessageAt: v.optional(v.number()),
    lastMessagePreview: v.optional(v.string()),
    lastMessageByName: v.optional(v.string()),
    archivedAt: v.optional(v.number()),
  }).index("by_scope", ["scopeType", "scopeId"]),

  // How far each participant has read. One row per (channel, actor) — the
  // alternative is a per-message read receipt table, which is an order of
  // magnitude more rows for a worse answer to "is there anything new".
  channelReads: defineTable({
    channelId: v.id("channels"),
    // clerkId (human) or agent document id.
    actorId: v.string(),
    lastReadAt: v.number(),
  })
    .index("by_actor", ["actorId"])
    .index("by_channel_and_actor", ["channelId", "actorId"]),

  // Outbound webhook endpoints. Owned by a user (configured in the UI) or
  // an agent (registered over MCP — this is how agents get pushed events
  // instead of polling). Empty eventTypes means "all events in scope".
  // Deliveries are HMAC-SHA256 signed with `secret`.
  webhookSubscriptions: defineTable({
    scopeType: v.union(v.literal("user"), v.literal("workspace")),
    scopeId: v.string(),
    url: v.string(),
    secret: v.string(),
    eventTypes: v.array(v.string()),
    listId: v.optional(v.id("lists")),
    ownerType: v.union(v.literal("user"), v.literal("agent")),
    ownerId: v.string(),
    enabled: v.boolean(),
    // Consecutive failures; reset on success, auto-disable at threshold.
    failureCount: v.number(),
    disabledAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_scope", ["scopeType", "scopeId"])
    .index("by_owner", ["ownerType", "ownerId"]),

  // One row per webhook delivery attempt chain (not per attempt — the row
  // is patched as retries happen). Kept for observability in the UI.
  webhookDeliveries: defineTable({
    subscriptionId: v.id("webhookSubscriptions"),
    eventId: v.id("events"),
    eventType: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("success"),
      v.literal("failed"),
    ),
    attempts: v.number(),
    responseStatus: v.optional(v.number()),
    lastError: v.optional(v.string()),
    createdAt: v.number(),
    completedAt: v.optional(v.number()),
  })
    .index("by_subscription", ["subscriptionId"])
    .index("by_event", ["eventId"]),

  // Sprints group tasks (from any list in the workspace) into a timebox.
  // `createdByActorId` is a clerkId or agent id.
  sprints: defineTable({
    workspaceId: v.id("workspaces"),
    name: v.string(),
    goal: v.optional(v.string()),
    startDate: v.number(),
    endDate: v.number(),
    status: v.union(
      v.literal("planned"),
      v.literal("active"),
      v.literal("complete"),
    ),
    // Planned capacity in story points; the planning view compares the
    // sum of committed tasks' estimatePoints against this.
    capacityPoints: v.optional(v.number()),
    // Retro notes captured when the sprint completes.
    retrospective: v.optional(v.string()),
    createdByActorId: v.string(),
    createdAt: v.number(),
  }).index("by_workspace", ["workspaceId"]),

  // Time-based recurring task definitions ("every Monday at 9am UTC"),
  // complementing the completion-triggered `tasks.recurrence`. An hourly
  // cron materializes rows whose nextRunAt has passed into real tasks.
  scheduledTasks: defineTable({
    listId: v.id("lists"),
    title: v.string(),
    description: v.optional(v.string()),
    priority: v.optional(
      v.union(
        v.literal("urgent"),
        v.literal("high"),
        v.literal("normal"),
        v.literal("low"),
      ),
    ),
    assigneeIds: v.array(v.string()),
    cadence: v.union(
      v.literal("hourly"),
      v.literal("daily"),
      v.literal("weekly"),
      v.literal("monthly"),
    ),
    // weekly: 0 (Sunday) – 6. monthly: 1–28. Ignored for hourly/daily.
    dayOfWeek: v.optional(v.number()),
    dayOfMonth: v.optional(v.number()),
    hourUtc: v.number(),
    // Days until the created task is due (undefined = no due date).
    dueInDays: v.optional(v.number()),
    nextRunAt: v.number(),
    lastRunAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
    lastErrorAt: v.optional(v.number()),
    consecutiveFailures: v.optional(v.number()),
    enabled: v.boolean(),
    createdByActorId: v.string(),
    createdAt: v.number(),
    // Phase L: when set, the materializer instantiates the full blueprint
    // (description/checklist/priority/estimate/SOP) instead of just the
    // schedule's bare title — daily ops defined once, run forever.
    blueprintId: v.optional(v.id("taskBlueprints")),
  })
    .index("by_list", ["listId"])
    .index("by_next_run", ["enabled", "nextRunAt"]),

  // ── Phase L: task blueprints ──
  // Reusable task definitions ("run the outreach checklist"): everything a
  // well-formed task carries, minus the list it lands on. Instantiated from
  // the UI or by recurring schedules; scoped like skills (personal or
  // workspace).
  taskBlueprints: defineTable({
    scopeType: v.union(v.literal("user"), v.literal("workspace")),
    scopeId: v.string(),
    name: v.string(),
    title: v.string(),
    description: v.optional(v.string()),
    priority: v.optional(
      v.union(
        v.literal("urgent"),
        v.literal("high"),
        v.literal("normal"),
        v.literal("low"),
      ),
    ),
    // Item texts only — ids are minted per instantiation.
    checklist: v.array(v.string()),
    estimatePoints: v.optional(v.number()),
    sopSlug: v.optional(v.string()),
    dueInDays: v.optional(v.number()),
    requiresApproval: v.optional(v.boolean()),
    createdByActorId: v.string(),
    createdAt: v.number(),
  }).index("by_scope", ["scopeType", "scopeId"]),

  // ── Revision requests ──
  // "This isn't right yet, here's what to change." A comment can say the same
  // thing, but a comment has no state: nothing tells you which asks are still
  // outstanding, and an agent reading a thread cannot tell a passing remark
  // from a blocking correction. A revision is explicit and addressable, and it
  // shows up in the agent's own queue.
  //
  // Lifecycle: open -> addressed (whoever did the work reports back, with a
  // note) -> accepted or reopened (a human decides). Agents may move
  // open -> addressed and nothing else, the same asymmetry as approval gates.
  revisions: defineTable({
    parentType: v.union(v.literal("task"), v.literal("list")),
    parentId: v.string(),
    body: v.string(),
    status: v.union(
      v.literal("open"),
      v.literal("addressed"),
      v.literal("accepted"),
    ),
    requestedByActorId: v.string(),
    requestedByName: v.string(),
    createdAt: v.number(),
    addressedAt: v.optional(v.number()),
    addressedByActorId: v.optional(v.string()),
    addressedByName: v.optional(v.string()),
    responseNote: v.optional(v.string()),
    acceptedAt: v.optional(v.number()),
    acceptedByClerkId: v.optional(v.string()),
  })
    .index("by_parent", ["parentType", "parentId"])
    // Ranged by the agent-facing "what is waiting on me" queries, so open
    // revisions never need a table scan.
    .index("by_status", ["status"]),

  // ── Agent operation receipts ──
  // Makes a timed-out write safe to retry. Without a receipt an agent cannot
  // tell whether a lost response means nothing happened, the write committed,
  // or it half-committed — so retrying risks duplicating a whole plan and not
  // retrying risks dropping it. With a caller-supplied idempotencyKey the
  // second attempt replays the stored result verbatim, including the ids the
  // first attempt created.
  agentOperations: defineTable({
    agentId: v.id("agents"),
    idempotencyKey: v.string(),
    tool: v.string(),
    result: v.any(),
    createdAt: v.number(),
  })
    .index("by_agent_and_key", ["agentId", "idempotencyKey"])
    .index("by_created", ["createdAt"]),

  // ── Phase L: per-user personalization ──
  // One row per user. homeWidgets is the ordered list of visible Home
  // cards (absent = default layout).
  userSettings: defineTable({
    clerkId: v.string(),
    homeWidgets: v.optional(v.array(v.string())),
    /**
     * Per-widget column width on Home, keyed by widget id.
     *
     * Separate from `homeWidgets` because they answer different questions —
     * which blocks are on the screen and in what order, versus how wide each
     * one is — and folding a width into an ordered id list would mean parsing
     * a composite key. Sparse: a widget with no entry uses its designed width,
     * so this stays empty for anyone who has never dragged a corner.
     */
    homeWidgetSpans: v.optional(v.any()),
    /** Heights by widget id, set by dragging a panel taller. */
    homeWidgetRows: v.optional(v.any()),
    // Per-list "Customize view" preferences, so a saved setup follows the
    // user across devices instead of living only in that browser's
    // localStorage. `settings` is the same compact `vs`/`vf` query-string
    // encoding src/lib/view-settings.ts already writes into the URL, so the
    // three storage layers (URL, server, localStorage) speak one language.
    // Capped and most-recent-first — see userSettings.setListViewSettings.
    listViewSettings: v.optional(
      v.array(v.object({ listId: v.id("lists"), settings: v.string() })),
    ),
    // Real-time notification preferences. Absent means the defaults (see
    // convex/notificationPrefs.ts), so no migration and no setup step. Turning
    // a category off silences the push, never the record.
    notificationPrefs: v.optional(
      v.object({
        realtime: v.optional(v.boolean()),
        mentions: v.optional(v.boolean()),
        assignments: v.optional(v.boolean()),
        approvals: v.optional(v.boolean()),
        revisions: v.optional(v.boolean()),
        agentPresence: v.optional(v.boolean()),
        agentErrors: v.optional(v.boolean()),
        taskUpdates: v.optional(v.boolean()),
      }),
    ),
  }).index("by_clerk", ["clerkId"]),

  // ── Phase L: workspace field library ──
  // Define a custom field once, apply it to any list (applying copies the
  // definition into that list's customFields, so per-list behavior is
  // unchanged downstream).
  fieldLibrary: defineTable({
    workspaceId: v.id("workspaces"),
    name: v.string(),
    type: v.union(
      v.literal("text"),
      v.literal("number"),
      v.literal("dropdown"),
      v.literal("date"),
      v.literal("checkbox"),
    ),
    options: v.optional(
      v.array(
        v.object({
          id: v.string(),
          label: v.string(),
          color: v.optional(v.string()),
        }),
      ),
    ),
    createdByActorId: v.string(),
    createdAt: v.number(),
  }).index("by_workspace", ["workspaceId"]),

  // User-authored skills — reusable markdown playbooks agents import over
  // MCP ("Sprint planner", "Backlog triage", …). Built-in skills live in
  // code (convex/skills.ts) and are merged into reads; rows here are the
  // workspace/personal custom ones.
  skills: defineTable({
    scopeType: v.union(v.literal("user"), v.literal("workspace")),
    scopeId: v.string(),
    slug: v.string(),
    name: v.string(),
    description: v.string(),
    content: v.string(),
    enabled: v.boolean(),
    createdByActorId: v.string(),
    updatedAt: v.number(),
    createdAt: v.number(),
  }).index("by_scope", ["scopeType", "scopeId"]),

  // ── Platform administration (SOC2) ──────────────────────────────────
  //
  // Super-admin roster. Being an admin is NEVER self-grantable: the root
  // of trust is the PLATFORM_ADMIN_EMAILS deployment env var (set out of
  // band). Env-allowlisted users are treated as superadmins; they can
  // grant scoped admin rows to others, and every grant/revoke is audited.
  // A normal end-user has no path to escalate into this table.
  platformAdmins: defineTable({
    clerkId: v.string(),
    email: v.string(),
    role: v.union(v.literal("superadmin"), v.literal("support")),
    grantedByClerkId: v.string(),
    createdAt: v.number(),
    revokedAt: v.optional(v.number()),
    revokedByClerkId: v.optional(v.string()),
  }).index("by_clerk_id", ["clerkId"]),

  // Append-only audit trail. Every admin action — and every break-glass
  // read of customer content — writes exactly one row here, with the
  // actor, target, and (for content access) a required reason. Rows are
  // never updated or deleted; retention pruning is deliberately excluded.
  adminAuditLog: defineTable({
    actorClerkId: v.string(),
    actorEmail: v.string(),
    action: v.string(),
    targetType: v.optional(v.string()),
    targetId: v.optional(v.string()),
    summary: v.optional(v.string()),
    reason: v.optional(v.string()),
    metadata: v.optional(v.any()),
    createdAt: v.number(),
  })
    .index("by_actor", ["actorClerkId"])
    .index("by_created", ["createdAt"])
    .index("by_target", ["targetType", "targetId"]),

  // Singleton platform-security configuration (one row per key). Edited
  // only by superadmins; every write is audited.
  platformSettings: defineTable({
    key: v.string(),
    value: v.any(),
    updatedByClerkId: v.string(),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),

  // Workspace invitations. Email is lowercased at write time; `token` is a
  // capability link (anyone signed-in holding it may accept), while the
  // in-app invite card requires the signed-in user's email to match.
  invites: defineTable({
    workspaceId: v.id("workspaces"),
    email: v.string(),
    role: v.union(v.literal("admin"), v.literal("member")),
    token: v.string(),
    invitedByClerkId: v.string(),
    createdAt: v.number(),
    acceptedAt: v.optional(v.number()),
    acceptedByClerkId: v.optional(v.string()),
    revokedAt: v.optional(v.number()),
  })
    .index("by_workspace", ["workspaceId"])
    .index("by_email", ["email"])
    .index("by_token", ["token"]),

  // In-app notification feed (assignments, mentions, approvals, invites,
  // due-soon/overdue reminders). One row per recipient per event; the
  // Inbox renders these newest-first and the sidebar badge counts unread.
  notifications: defineTable({
    userClerkId: v.string(),
    type: v.string(),
    title: v.string(),
    body: v.optional(v.string()),
    href: v.optional(v.string()),
    readAt: v.optional(v.number()),
    createdAt: v.number(),
  }).index("by_user", ["userClerkId", "createdAt"]),

  // Task file attachments. Bytes live in Convex file storage; rows are
  // metadata. Deleted with their task.
  attachments: defineTable({
    taskId: v.id("tasks"),
    storageId: v.id("_storage"),
    name: v.string(),
    mimeType: v.string(),
    sizeBytes: v.number(),
    uploadedByActorId: v.string(),
    createdAt: v.number(),
  }).index("by_task", ["taskId"]),

  // Public intake forms: a tokenized form per list that outsiders can
  // submit without an account; each submission becomes a task. Token is a
  // capability URL segment; disabled forms 404.
  forms: defineTable({
    listId: v.id("lists"),
    token: v.string(),
    title: v.string(),
    description: v.optional(v.string()),
    // Which task fields the form asks for beyond the title.
    askDescription: v.optional(v.boolean()),
    askPriority: v.optional(v.boolean()),
    askEmail: v.optional(v.boolean()),
    enabled: v.boolean(),
    createdByClerkId: v.string(),
    createdAt: v.number(),
    submissionCount: v.optional(v.number()),
  })
    .index("by_list", ["listId"])
    .index("by_token", ["token"]),

  // Precomputed per-list task rollups, maintained inside the task write
  // cores so Home/Space overviews read counters instead of scanning tasks.
  listRollups: defineTable({
    listId: v.id("lists"),
    total: v.number(),
    done: v.number(),
    inProgress: v.number(),
    updatedAt: v.number(),
  }).index("by_list", ["listId"]),

  // Named filter presets per list: a saved view captures the active view
  // (list/board/calendar/gantt) plus the URL filter state, so a team can
  // one-click into "Active board" or "My urgent". Anyone with list access
  // can create and delete them (they're navigation, not data).
  savedViews: defineTable({
    listId: v.id("lists"),
    name: v.string(),
    view: v.union(
      v.literal("overview"),
      v.literal("list"),
      v.literal("board"),
      v.literal("table"),
      v.literal("calendar"),
      v.literal("gantt"),
      v.literal("timeline"),
      v.literal("workload"),
      v.literal("network"),
    ),
    // Mirrors of the URL params: ?f= (comma flags) and ?pri=.
    flags: v.optional(v.string()),
    priority: v.optional(v.string()),
    createdByClerkId: v.string(),
    createdAt: v.number(),
  }).index("by_list", ["listId"]),

  // Per-user starred items: the Favorites rail in the sidebar and the
  // pinned row on the Projects directory. Navigation state, not data —
  // rows point at entities by raw id string and are dropped if stale.
  favorites: defineTable({
    userClerkId: v.string(),
    entityType: v.union(
      v.literal("list"),
      v.literal("project"),
      v.literal("space"),
      v.literal("doc"),
      v.literal("whiteboard"),
    ),
    entityId: v.string(),
    position: v.number(),
    createdAt: v.number(),
  })
    .index("by_user", ["userClerkId"])
    .index("by_user_entity", ["userClerkId", "entityType", "entityId"]),

  // Reusable checklist playbooks ("Definition of done", "Release steps").
  // Scoped like skills to a user or workspace; applying one copies its
  // items onto a task's embedded checklist.
  checklistTemplates: defineTable({
    scopeType: v.union(v.literal("user"), v.literal("workspace")),
    scopeId: v.string(),
    name: v.string(),
    items: v.array(v.string()),
    createdByActorId: v.string(),
    createdAt: v.number(),
  }).index("by_scope", ["scopeType", "scopeId"]),

  // ── x402 agent payments ─────────────────────────────────────────────
  //
  // A prepaid credit wallet per billing scope (a user's personal space or a
  // workspace). Every agent in that scope shares the wallet. Metered agent
  // actions consume `balance`; agents top the wallet up by paying via the
  // x402 protocol (HTTP 402 → signed on-chain payment → credits granted).
  // Balances are integer credit units — never floats.
  agentWallets: defineTable({
    scopeType: v.union(v.literal("user"), v.literal("workspace")),
    scopeId: v.string(),
    balance: v.number(),
    lifetimeCredits: v.number(),
    lifetimeSpent: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
    /**
     * The FLEET's daily spend ceiling in USD, and its rolling counter.
     *
     * Per-agent ceilings alone do not answer the question an agency owner
     * actually asks: ten agents at twenty dollars each is a two-hundred
     * dollar day nobody agreed to. This is the number they set. It lives on
     * the wallet because the wallet is already this scope's money object,
     * and it is already loaded on the metered path — so the fleet ceiling
     * costs no extra read.
     *
     * `spendDay` is the UTC day `spendUsdToday` accumulates against; a
     * counter from an older day reads as zero rather than being swept.
     */
    dailySpendUsdLimit: v.optional(v.number()),
    spendDay: v.optional(v.string()),
    spendUsdToday: v.optional(v.number()),
  }).index("by_scope", ["scopeType", "scopeId"]),

  // Ledger of x402 settlements. One row per top-up (settled or failed).
  // `nonce` is unique per payment authorization and enforced on the way in
  // (by_nonce lookup) so a payment can never be replayed to double-credit.
  // We store only settlement metadata — never the private keys agents sign
  // with; on-chain data (txReference, payer) is inherently public.
  payments: defineTable({
    scopeType: v.union(v.literal("user"), v.literal("workspace")),
    scopeId: v.string(),
    agentId: v.optional(v.id("agents")),
    asset: v.string(),
    network: v.string(),
    // Atomic units of `asset` paid, kept as a string to avoid float error.
    amountAtomic: v.string(),
    creditsGranted: v.number(),
    payer: v.optional(v.string()),
    nonce: v.string(),
    txReference: v.optional(v.string()),
    facilitator: v.string(),
    status: v.union(v.literal("settled"), v.literal("failed")),
    reason: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_scope", ["scopeType", "scopeId", "createdAt"])
    .index("by_nonce", ["nonce"]),

  // Append-only staff credit ledger. Grants, refunds, and clawbacks are
  // never written onto `payments` (that table is the x402 settlement log
  // and its nonce uniqueness is load-bearing). Each row is one audited
  // adjustment; the wallet balance is the running total.
  creditAdjustments: defineTable({
    scopeType: v.union(v.literal("user"), v.literal("workspace")),
    scopeId: v.string(),
    kind: v.union(
      v.literal("grant"),
      v.literal("refund"),
      v.literal("debit"),
    ),
    // Always positive. Direction comes from `kind`.
    credits: v.number(),
    paymentId: v.optional(v.id("payments")),
    reason: v.string(),
    createdByClerkId: v.string(),
    createdAt: v.number(),
  })
    .index("by_scope", ["scopeType", "scopeId", "createdAt"])
    .index("by_payment", ["paymentId"]),

  // The Chat dashboard's substrate: an append-only log of signed, kind-tagged
  // events, its tag index, and the keys that sign into it. Defined in
  // convex/buzz/_tables.ts — a different kind of thing from the mutable domain
  // rows above, and kept out of this file so it costs it two lines forever.
  ...buzzTables,
  // Notification settings and mutes. They live beside the module that reads
  // them rather than in _tables.ts because they are ordinary preference rows,
  // not part of the signed log — and because absence is meaningful here: no row
  // means "never opened the settings screen", which is the defaults, so there
  // is nothing to create on signup and nothing to migrate.
  ...buzzNotificationTables,
  // The reminder projection. The log is the record — every reminder is a signed,
  // author-gated kind 30300 — but `not_before` is not a filterable tag and every
  // index on the log leads with the community, so "everything due now, anywhere"
  // has nowhere to range. Declared in convex/buzz/reminders.ts beside the cron
  // that is its only reason to exist.
  ...buzzReminderTables,
  // Reports, the append-only action log, and community restrictions. The action
  // log is the one table in the product that retention must never learn about:
  // a moderation record whose job is to outlive the thing it was about cannot
  // be pruned on the same schedule as the thing it was about.
  ...buzzModerationTables,
  // Workflows, their runs, their approval gates, and the at-most-once claim a
  // scheduled fire takes. The claim is a row rather than an in-memory filter
  // because ours is written in the same serializable transaction that reads it
  // — the claim IS the mechanism, not a second weaker copy of one.
  ...buzzWorkflowTables,
  // The bridge's one row: which project a room is about. Only a pointer — the
  // whole of C12 is reads across the two sides, and the single fact neither
  // side can hold alone is the edge between them.
  ...buzzBridgeTables,
});
