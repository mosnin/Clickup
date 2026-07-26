import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

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
    name: v.optional(v.string()),
    imageUrl: v.optional(v.string()),
    onboardedAt: v.optional(v.number()),
    // Platform-admin account controls. A suspended user is blocked from
    // every authenticated operation (enforced in _authz.requireIdentity).
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
    // ── Roadmap membership (Phase K) ──
    // A project can sit in one roadmap phase; roadmapPosition orders it
    // within that phase. All optional — projects outside roadmaps are fine.
    roadmapId: v.optional(v.id("roadmaps")),
    roadmapPhaseId: v.optional(v.string()),
    roadmapPosition: v.optional(v.number()),
    // ── Project metadata (a list IS a project) ──
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
    // Accountable human (clerkId) or agent (agent doc id).
    ownerActorId: v.optional(v.string()),
    // Freeform project notes: decisions, links, context. Plain text.
    notes: v.optional(v.string()),
    // Target completion date (local-midnight ms).
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
  // launch trains…) that projects (lists) slot into. Phases are embedded:
  // small, ordered, and always fetched with the roadmap.
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
    createdByClerkId: v.string(),
    position: v.number(),
    createdAt: v.number(),
    completedAt: v.optional(v.number()),
  })
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
  })
    .index("by_plan", ["planId", "dispatchedAt"])
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
      v.literal("channel"),
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
    parentType: v.union(v.literal("doc"), v.literal("task")),
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
    // ── Phase L: auto-rollup ──
    // When set, progress derives live from the linked list's completed-task
    // rollup on every read; manual setProgress is refused. "Move things
    // forward" becomes visible without anyone logging numbers.
    sourceListId: v.optional(v.id("lists")),
  })
    .index("by_parent", ["parentType", "parentId"])
    .index("by_source", ["sourceListId"]),

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
    // Direct push endpoint: assignments and mentions POST a small ping
    // here even when the agent has no webhook subscription, so "assign an
    // agent" works out of the box. When notifySecret is set, pings carry
    // an HMAC-SHA256 X-Ping-Signature header.
    notifyUrl: v.optional(v.string()),
    notifySecret: v.optional(v.string()),
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
  }).index("by_parent", ["parentType", "parentId"]),

  // One row per (agent, UTC day) counting mutations, for the daily action
  // budget. Cheap: single indexed read + patch per agent mutation.
  agentUsage: defineTable({
    agentId: v.id("agents"),
    day: v.string(), // "YYYY-MM-DD" UTC
    count: v.number(),
    // Sliding burst window: mutations in the current minute.
    minute: v.optional(v.string()), // "YYYY-MM-DDTHH:MM" UTC
    minuteCount: v.optional(v.number()),
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
  }).index("by_agent", ["agentId"]),

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
    createdByActorId: v.string(),
    createdAt: v.number(),
  }).index("by_scope", ["scopeType", "scopeId"]),

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
});
