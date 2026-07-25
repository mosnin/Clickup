import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { requireIdentity } from "./_authz";

// Skills: markdown playbooks agents import over MCP (list_skills /
// get_skill) that teach them how to run a process — sprint planning,
// triage, standups — using the MCP tools this product exposes. Built-in
// skills ship in code below; workspaces and users can author their own,
// stored in the `skills` table and merged into every read. A custom skill
// with the same slug as a built-in overrides it.

export type SkillShape = {
  slug: string;
  name: string;
  description: string;
  content: string;
  builtin: boolean;
  enabled: boolean;
};

export const BUILTIN_SKILLS: Omit<SkillShape, "builtin" | "enabled">[] = [
  {
    slug: "collaboration-protocol",
    name: "Collaboration protocol",
    description:
      "How to work on tasks alongside other agents and humans without stepping on toes. Import this first.",
    content: `# Collaboration protocol

You are one of several agents (and humans) working in this workspace. Follow this loop for every piece of work:

1. **Find work**: \`next_task\` picks the best open, unclaimed, unblocked task for you (assignments first, then unassigned). Also check \`list_my_mentions\` for direct requests.
2. **Load and acknowledge the source of truth**: \`get_task\` returns every attached \`contextPacket\` in full plus \`contextReadiness\`. Read every packet, then call \`acknowledge_task_context\` with every packet id and exact version. This receipt is an execution invariant: a later packet edit makes you stale, and Operate refuses claim/start/complete until you re-read and acknowledge. Treat packet objectives and constraints as authoritative and record versions in your run summary.
3. **Absorb decision changes explicitly**: inspect the task's \`decisions\` (or call \`list_decisions_for_task\`). Read the active version, every superseded version relevant to the task, and the rationale. A pending impact is not permission to guess: call \`assess_decision_impact\` with \`no_change\` only when the task already conforms, or \`rework_required\` with a concrete note. Complete the rework and mark it \`resolved\` before execution continues. If you change operating policy, use \`create_decision\` or \`supersede_decision\`; never bury a policy reversal in a comment.
4. **Claim before working**: call \`claim_task\` after context and decision impacts are current. If it fails because the task is taken, move on. Claims expire after 60 minutes, so re-claim if a long task runs past that.
5. **Open a run**: \`start_run\` with a one-line title so humans can audit the session later. A task run requires your fresh claim and only one may be active per agent/task. \`finish_run\` exactly once with succeeded/failed/abandoned, a concise summary, and artifact URLs. An exact retry is safe; a conflicting terminal rewrite is refused. For dispatched plans this automatically updates the execution ledger visible through \`get_execution_control\`.
6. **Show your status**: call \`heartbeat\` with \`currentTaskId\` and a short \`statusText\` ("writing migration script…") every few minutes. Humans watch this live; going silent for 30+ minutes gets you flagged as stalled and your claim eventually expires.
7. **Narrate meaningful progress**: post \`add_comment\` on the task when you finish a step or hit a blocker. Record operating-policy changes with the decision tools, not only a comment. Mention people with \`@[Name](id)\` tokens (get ids from \`list_members\`). For longer multi-agent discussion, open a topic channel (\`create_channel\`) instead of flooding the main chat.
8. **Respect dependencies and gates**: \`get_task\` shows \`blockedByTaskIds\` and \`requiresApproval\`. Completing is refused while a blocker is open. If a task needs approval, finish the work, tick the checklist, then call \`request_approval\` with a note on what to review, it lands in the humans' inbox and emails them. The \`task.approved\` event tells you when to \`complete_task\`. Report artifacts (PR links, docs) and cost via \`finish_run\`.
9. **Finish cleanly**: tick acceptance criteria with \`set_checklist\`, then \`complete_task\`. Completing releases your claim automatically.
10. **Hand off when stuck**: \`handoff_task\` with a note covering state, what you tried, what's left, the context-packet versions, and active decision versions you used. If something breaks and you can't proceed, \`report_error\`, never just go quiet.

Etiquette: don't edit a task's description someone else owns without a comment; don't complete tasks with unchecked checklist items unless told to; keep statusText honest.`,
  },
  {
    slug: "sprint-planner",
    name: "Sprint planner",
    description:
      "Plan a sprint: gather candidates, balance load across agents and humans, create the sprint, and pull tasks in.",
    content: `# Sprint planner

Goal: produce a committed, balanced sprint.

1. **Timebox**: agree the window (default: 2 weeks starting next Monday). Before hand-rolling one, check \`list_sprint_templates\` — the built-in playbooks carry a length, a goal template, ceremonies, and starter tasks with estimates and acceptance criteria already written. \`apply_sprint_template(slug, startDate, listId)\` creates the sprint AND materializes that work into the list, attached to the sprint with due dates clamped to the window; drop \`listId\` to get the timebox alone. Nothing to reuse? \`create_sprint\` (status stays "planned" until kickoff). Both are workspace-only.
2. **Gather candidates**: \`list_tasks\` across the backlog lists, filter to open tasks. Rank by priority, then due date, then age.
3. **Estimate capacity**: \`list_members\` for the roster. Assume each member (human or agent) can own 5–8 tasks per 2-week sprint unless workload data says otherwise.
4. **Fill the sprint**: for each chosen task, \`update_task\` with \`sprintId\` and an assignee. Balance assignments; leave ~20% slack for urgent arrivals.
5. **Wire dependencies**: where task B needs task A, \`add_dependency\` so nobody starts B early.
6. **Kick off**: \`update_sprint\` to status "active", then \`add_comment\` in the workspace chat summarizing the sprint goal and each member's focus.
7. **During the sprint**: run \`sprint_summary\` daily; flag overdue or blocked tasks with comments mentioning their assignee.
8. **Close**: at the end date, move unfinished tasks to the next sprint or back to backlog, \`update_sprint\` to "complete", and post a retro summary comment (what shipped, what slipped, why).`,
  },
  {
    slug: "daily-standup",
    name: "Daily standup",
    description:
      "Post a morning standup summary: what happened yesterday, what's in flight, what's blocked.",
    content: `# Daily standup

Produce one workspace-chat message covering the last 24h.

1. \`list_events\` since yesterday. Group by actor.
2. For each member with activity: one line, tasks completed, tasks started (claimed/status-changed), comments worth noting.
3. **Blocked list**: \`list_tasks\` for open tasks; call out tasks whose blockers are still open, tasks overdue, and tasks claimed >24h without completion (possible stuck agent).
4. **Today**: from the active sprint (\`sprint_summary\`), list the highest-priority open tasks per assignee.
5. Post it with \`add_comment\` (parent: workspace chat). Keep it under 30 lines. Mention anyone who owns a blocker.`,
  },
  {
    slug: "backlog-triage",
    name: "Backlog triage",
    description:
      "Sweep untriaged tasks: fill in priority, due dates, checklists, assignees, and dependencies.",
    content: `# Backlog triage

Sweep every list and make each open task actionable.

For each task from \`list_tasks\` that is missing metadata:

1. **Priority**: infer from the title/description (outage/security → urgent; customer-facing bug → high; cleanup → low). \`update_task\`.
2. **Acceptance criteria**: if the description implies multiple steps, encode them with \`set_checklist\` (3–7 concrete, verifiable items).
3. **Assignee**: match the task to the best member by their recent activity (\`list_events\`), or leave unassigned and note why.
4. **Dependencies**: if the task obviously needs another open task first, \`add_dependency\`.
5. **Split**: if a task is really 3+ tasks, create subtasks with \`create_task\` (parentTaskId) and a checklist on the parent.
6. Leave an \`add_comment\` audit trail on anything you changed materially, so humans can review your triage decisions.

## Custom fields are part of triage

Lists carry structured fields beyond title/status/priority, and a half-filled field is invisible to every report and filter downstream. Treat them as required triage output.

1. \`list_custom_fields(listId)\` once per list. Each field returns its \`type\`, \`options\`, \`config\`, and a \`writeHint\` naming the exact argument to send. Fields with \`computed: true\` (rollup, formula) are derived — never try to write them.
2. \`get_task_fields(taskId)\` to see what's already filled, including the computed values.
3. \`set_task_field\` per gap, sending the argument the writeHint asks for: \`textValue\` for text/long_text/email/phone/url and for a dropdown's option id, \`numberValue\` for number/money/rating/progress, \`optionIds\` for labels, \`actorIds\` for people (ids from \`list_members\`), \`taskIds\` for relationship, \`booleanValue\` for checkbox and for voting (true adds your vote), \`dateValue\` for date, \`location\` for location, \`files\` for files.
4. Values are validated server-side against the field's config — a rating above its \`ratingMax\`, a bad email, or an option id that doesn't exist is refused with a message telling you what to send. Read the refusal and correct it; don't retry the same call.
5. \`clear_task_field\` when a value is wrong and you have nothing better to put there. Empty is honest; a wrong value isn't.`,
  },
  {
    slug: "execution-plan-compiler",
    name: "Execution plan compiler",
    description:
      "Turn a confirmed conversation or brief into one auditable roadmap, multi-project task graph, and shared agent context without inventing missing facts.",
    content: `# Execution plan compiler

Use this when a human asks you to turn a conversation, transcript, PRD, or operating brief into a roadmap and parallel execution plan.

## 1. Separate facts from inference

Before creating anything, extract:

- **Objective**: one outcome sentence.
- **Success criteria**: observable tests that prove the outcome.
- **Confirmed source context**: the relevant conversation/brief faithfully preserved.
- **Assumptions**: every inference you need to make, explicitly labeled.
- **Open questions**: unresolved decisions that agents must not silently guess.

Do not bury an assumption inside a task description. If a missing answer changes architecture, scope, permissions, money, or an irreversible action, keep it in openQuestions and create an approval-gated decision task before dependent execution.

## 2. Design the graph

1. \`get_execution_policy\`, then \`get_tree\` for the destination workspace Space. Supervised work requires human plan approval. Bounded autonomy only policy-authorizes plans within its task ceiling that have no open questions and no approval-gated tasks.
2. \`list_members\` for real human and agent ids, advertised capabilities, concurrency ceilings, and live load. Never invent assignee ids or assume a capability that is not listed.
3. Define ordered roadmap phases with short refs.
4. Define 1–12 projects. Each project belongs to one phase and has 1–50 tasks.
5. Give every task a short ref unique inside its project.
6. Use \`parentRef\` only for an earlier task in the same project.
7. Use \`dependsOn: ["taskRef"]\` inside one project and \`dependsOn: ["otherProject.taskRef"]\` across projects.
8. Put verifiable acceptance criteria in each task's checklist and explicit \`requiredCapabilities\` on specialized work. Use \`requiresApproval\` for decisions or high-impact changes.
9. Assign only when an agent advertises every required capability. Independent tasks can run in parallel; express real ordering with dependencies instead of prose.

## 3. Commit atomically

Call \`create_execution_plan\` once with a stable idempotencyKey derived from the conversation/document id and revision. The call validates refs, scope, assignees, and dependency cycles before committing. It then creates:

- one immutable provenance manifest;
- one phased roadmap;
- every project;
- every task and subtask;
- cross-project blockers;
- one versioned operating brief per project, attached to every task.

The call is transactional: any error creates nothing. Retry the exact same payload with the same idempotencyKey. If the plan changes, use a new key.

## 4. Verify and launch

1. \`get_execution_plan\` and compare counts, source, assumptions, open questions, review status, and generated ids to your intended graph.
2. \`get_roadmaps\` to verify phase placement.
3. Sample the critical-path tasks with \`get_task\`; confirm blockers, assignees, checklists, and attached operating brief.
4. Read the returned authorization source and reason. Never trim tasks, hide uncertainty, or remove approval gates to qualify for autonomous authorization. An agent must never claim, fabricate, or change authorization.
5. Call \`get_execution_readiness\` before releasing work. Require \`dispatchAuthorized\`; verify the active policy version and rolling capacity, then inspect capability gaps, exhausted capacity, dependency blocks, prior dispatch leases, and runtimes that require polling.
6. Call \`dispatch_execution_wave\` with a stable wave idempotency key. If open questions remain, record exactly what was resolved, deferred, or bounded in \`openQuestionDisposition\`; never silently wave uncertainty through.
7. Dispatched agents follow the collaboration protocol: read and acknowledge context, claim, start a run, heartbeat, and finish. Completing blockers makes the next wave eligible.
8. Never dispatch an unresolved task merely because the graph exists. Open questions remain visible context until their disposition is auditable.`,
  },
  {
    slug: "project-kickoff",
    name: "Project kickoff",
    description:
      "Stand up a new project from a one-paragraph brief: space, lists, milestone tasks, dependencies, and a kickoff doc.",
    content: `# Project kickoff

Input: a short brief (goal, rough deadline, who's involved).

0. **Don't start from a blank page**: \`list_templates\` first, filtered by \`useCase\` or \`search\` against the brief. The Template Center covers lists (with their statuses, fields, and starter tasks), single tasks, docs, whiteboards, and saved view presets. \`get_template(slug)\` shows exactly what a slug will create before you commit; \`apply_template(slug, destinationType, destinationId, name?)\` creates it — a list template into a space or folder, a task or view template onto a list, a doc or whiteboard into a space. Applying a template is the same write path as building by hand, so everything below still applies on top of it. Adopt the parts that fit, then fill the gaps with the steps below.
1. **Compile the confirmed brief first**: for a multi-project kickoff, fetch the \`execution-plan-compiler\` skill and use \`create_execution_plan\` once. It atomically creates the roadmap, phased projects, tasks/subtasks, cross-project dependencies, assignments, and attached operating briefs while preserving source context, assumptions, and open questions. Use the manual steps below only for additions or a deliberately bespoke structure.
2. **Structure**: \`create_space\` named after the project. Inside it, \`create_list\` per milestone (or "Backlog" + "Milestones" for a small project). Group related lists with \`create_folder\`, and regroup later with \`move_list\` (into a folder, back out to the space, or over to a sibling — the destination must be in the same space). Then \`assign_project_to_phase\` to place each list on the roadmap, and \`update_list_meta\` to set each project's description and target date. Typo'd a name? \`rename_list\` / \`rename_folder\`. Wrong grouping? \`reorder_folders\` / \`reorder_lists\`, or \`delete_folder\` — that one only ungroups, every list inside moves up to the space with its tasks intact. Wrong shape entirely? \`delete_list\` and redo.
3. **Checkpoints inside each project**: \`create_milestone\` per dated checkpoint of that project ("Design freeze", "Beta cut") with its \`targetDate\`. Roadmap phases sequence PROJECTS; milestones are the timeline INSIDE one project — use both when a project spans weeks. \`list_milestones\` shows derived progress (done/total of linked tasks) at any time.
4. **Plan in bulk**: decompose each milestone with ONE \`create_tasks\` call — epic tasks flagged \`milestone: true\` with \`estimatePoints\` and due dates, subtasks nested via \`parentRef\`, and cross-task dependencies via \`dependsOn\` (refs or task ids, cross-list allowed). Encode quality gates ("p95 < 200ms") as \`checklist\` acceptance criteria. Then \`set_task_milestone\` each task onto the checkpoint it belongs to, so every milestone's progress moves on its own. Use \`reorder_tasks\` if execution order matters beyond dependencies.
5. **Workflow fit**: need a stage or field the defaults lack? \`create_status\` (e.g. "QA", category in_progress) and \`create_custom_field\`. Fields are the project's structured memory — define them at kickoff, not after the data is already lost. The full type set: text, long_text, number, money (\`config.currency\`), dropdown, labels (multi-select), date, checkbox, email, phone, url, location, rating (\`config.ratingMax\`), progress, people, files, relationship (\`config.relationListId\`), voting, plus the computed \`rollup\` (sum/avg/count over subtasks or a relationship field) and \`formula\` (arithmetic over other numeric fields, written as \`{Field name} * 2\`). A kickoff usually wants at least: a "Severity" or "Impact" dropdown, an "Owner" people field, an "Effort" number, and a formula or rollup that turns those into one number humans can sort by. Then fill them as you create tasks (\`set_task_field\`) — \`list_custom_fields\` returns a \`writeHint\` per field naming the exact argument to send.
6. **Track it**: \`create_goal\` with \`sourceListId\` pointing at the main list — progress then rolls up automatically from completed tasks. \`create_sprint\` for the first timebox and pull tasks in.
7. **Kickoff doc**: \`create_doc\` titled "<Project>, brief" containing the goal, scope boundaries, milestone table, and links/ids of the milestone tasks. Write project conventions as a custom skill (\`create_skill\`) so future agents inherit them.
8. **Shared context packet**: \`create_context_packet\` with the objective, non-goals, constraints, confirmed decisions, references, and open questions; attach it to every task created above in the same call. This is the compact source of truth agents load through \`get_task\`. Update the packet when a decision changes instead of copying new instructions into twenty descriptions.
9. **Recurring heartbeat**: \`create_scheduled_task\` for a weekly "<Project> status update" task assigned to yourself.
10. **Announce**: workspace-chat comment mentioning everyone involved, linking the doc and the first tasks.`,
  },
  {
    slug: "progress-reporter",
    name: "Progress reporter",
    description:
      "Compile an on-demand or weekly progress report across sprints, tasks, and goals for human review.",
    content: `# Progress reporter

Produce a report a busy human can read in 60 seconds.

1. **Sprint state**: \`sprint_summary\` for the active sprint, done vs total, days remaining, on-track verdict (done% vs time-elapsed%).
2. **Movement**: \`list_events\` for the period, completed tasks (call out who/what), new tasks created, anything reopened.
3. **Risks**: overdue tasks, tasks blocked >2 days, unassigned urgent tasks, agents that haven't heartbeat in >1h while holding claims.
4. **Next**: top 5 upcoming tasks by priority/due date.
5. Deliver as a workspace-chat comment (or \`create_doc\` if >40 lines) with sections: Shipped / In flight / At risk / Next.`,
  },
];

async function requireScopeMembership(
  ctx: QueryCtx | MutationCtx,
  scopeType: "user" | "workspace",
  scopeId: string,
): Promise<string> {
  const identity = await requireIdentity(ctx);
  if (scopeType === "user") {
    if (scopeId !== identity.subject) throw new ConvexError("Forbidden");
  } else {
    const member = await ctx.db
      .query("memberships")
      .withIndex("by_user_and_workspace", (q) =>
        q
          .eq("userClerkId", identity.subject)
          .eq("workspaceId", scopeId as Id<"workspaces">),
      )
      .unique();
    if (!member) throw new ConvexError("Forbidden");
  }
  return identity.subject;
}

// Merge built-ins with custom rows for a scope. Custom rows win on slug
// collisions so teams can tailor the stock playbooks.
export async function skillsForScope(
  ctx: QueryCtx | MutationCtx,
  scopeType: "user" | "workspace",
  scopeId: string,
): Promise<(SkillShape & { _id?: Id<"skills"> })[]> {
  const custom = await ctx.db
    .query("skills")
    .withIndex("by_scope", (q) =>
      q.eq("scopeType", scopeType).eq("scopeId", scopeId),
    )
    .collect();
  const customBySlug = new Map(custom.map((s) => [s.slug, s]));
  const out: (SkillShape & { _id?: Id<"skills"> })[] = [];
  for (const b of BUILTIN_SKILLS) {
    const override = customBySlug.get(b.slug);
    if (override) continue; // custom row replaces the builtin below
    out.push({ ...b, builtin: true, enabled: true });
  }
  for (const c of custom) {
    out.push({
      _id: c._id,
      slug: c.slug,
      name: c.name,
      description: c.description,
      content: c.content,
      builtin: false,
      enabled: c.enabled,
    });
  }
  return out;
}

// ── Clerk-authenticated API ────────────────────────────────────────────

export const listForScope = query({
  args: {
    scopeType: v.union(v.literal("user"), v.literal("workspace")),
    scopeId: v.string(),
  },
  handler: async (ctx, { scopeType, scopeId }) => {
    try {
      await requireScopeMembership(ctx, scopeType, scopeId);
    } catch {
      return [];
    }
    const skills = await skillsForScope(ctx, scopeType, scopeId);
    // Trim content for the list view.
    return skills.map(({ content: _content, ...rest }) => rest);
  },
});

export const get = query({
  args: {
    scopeType: v.union(v.literal("user"), v.literal("workspace")),
    scopeId: v.string(),
    slug: v.string(),
  },
  handler: async (ctx, { scopeType, scopeId, slug }) => {
    try {
      await requireScopeMembership(ctx, scopeType, scopeId);
    } catch {
      return null;
    }
    const skills = await skillsForScope(ctx, scopeType, scopeId);
    return skills.find((s) => s.slug === slug) ?? null;
  },
});

export const create = mutation({
  args: {
    scopeType: v.union(v.literal("user"), v.literal("workspace")),
    scopeId: v.string(),
    slug: v.string(),
    name: v.string(),
    description: v.string(),
    content: v.string(),
  },
  handler: async (ctx, args) => {
    const subject = await requireScopeMembership(
      ctx,
      args.scopeType,
      args.scopeId,
    );
    const slug = args.slug
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    if (!slug) throw new ConvexError("Slug is required");
    const existing = await ctx.db
      .query("skills")
      .withIndex("by_scope", (q) =>
        q.eq("scopeType", args.scopeType).eq("scopeId", args.scopeId),
      )
      .collect();
    if (existing.some((s) => s.slug === slug)) {
      throw new ConvexError("A skill with this slug already exists");
    }
    return await ctx.db.insert("skills", {
      scopeType: args.scopeType,
      scopeId: args.scopeId,
      slug,
      name: args.name,
      description: args.description,
      content: args.content,
      enabled: true,
      createdByActorId: subject,
      updatedAt: Date.now(),
      createdAt: Date.now(),
    });
  },
});

export const update = mutation({
  args: {
    skillId: v.id("skills"),
    name: v.optional(v.string()),
    description: v.optional(v.string()),
    content: v.optional(v.string()),
    enabled: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const skill = await ctx.db.get(args.skillId);
    if (!skill) throw new ConvexError("Skill not found");
    await requireScopeMembership(ctx, skill.scopeType, skill.scopeId);
    const patch: Record<string, unknown> = { updatedAt: Date.now() };
    if (args.name !== undefined) patch.name = args.name;
    if (args.description !== undefined) patch.description = args.description;
    if (args.content !== undefined) patch.content = args.content;
    if (args.enabled !== undefined) patch.enabled = args.enabled;
    await ctx.db.patch(args.skillId, patch);
  },
});

export const remove = mutation({
  args: { skillId: v.id("skills") },
  handler: async (ctx, { skillId }) => {
    const skill = await ctx.db.get(skillId);
    if (!skill) return;
    await requireScopeMembership(ctx, skill.scopeType, skill.scopeId);
    await ctx.db.delete(skillId);
  },
});
