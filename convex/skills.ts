import { v } from "convex/values";
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
2. **Claim before working**: call \`claim_task\` before you start. If it fails, the task is taken, move on. Claims expire after 60 minutes, so re-claim if a long task runs past that.
3. **Open a run**: \`start_run\` with a one-line title so humans can audit the session later; \`finish_run\` with succeeded/failed + a summary when done.
4. **Show your status**: call \`heartbeat\` with \`currentTaskId\` and a short \`statusText\` ("writing migration script…") every few minutes. Humans watch this live; going silent for 30+ minutes gets you flagged as stalled and your claim eventually expires.
5. **Narrate meaningful progress**: post \`add_comment\` on the task when you finish a step, hit a blocker, or make a decision worth recording. Mention people with \`@[Name](id)\` tokens (get ids from \`list_members\`). For longer multi-agent discussion, open a topic channel (\`create_channel\`) instead of flooding the main chat.
6. **Respect dependencies and gates**: \`get_task\` shows \`blockedByTaskIds\` and \`requiresApproval\`. Completing is refused while a blocker is open. If a task needs approval, finish the work, tick the checklist, then call \`request_approval\` with a note on what to review, it lands in the humans' inbox and emails them. The \`task.approved\` event tells you when to \`complete_task\`. Report artifacts (PR links, docs) and cost via \`finish_run\`.
7. **Finish cleanly**: tick acceptance criteria with \`set_checklist\`, then \`complete_task\`. Completing releases your claim automatically.
8. **Hand off when stuck**: \`handoff_task\` with a note covering state, what you tried, and what's left. If something breaks and you can't proceed, \`report_error\`, never just go quiet.

Etiquette: don't edit a task's description someone else owns without a comment; don't complete tasks with unchecked checklist items unless told to; keep statusText honest.`,
  },
  {
    slug: "sprint-planner",
    name: "Sprint planner",
    description:
      "Plan a sprint: gather candidates, balance load across agents and humans, create the sprint, and pull tasks in.",
    content: `# Sprint planner

Goal: produce a committed, balanced sprint.

1. **Timebox**: agree the window (default: 2 weeks starting next Monday). Create it with \`create_sprint\` (status stays "planned" until kickoff).
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
6. Leave an \`add_comment\` audit trail on anything you changed materially, so humans can review your triage decisions.`,
  },
  {
    slug: "project-kickoff",
    name: "Project kickoff",
    description:
      "Stand up a new project from a one-paragraph brief: space, lists, milestone tasks, dependencies, and a kickoff doc.",
    content: `# Project kickoff

Input: a short brief (goal, rough deadline, who's involved).

1. **Structure**: \`create_space\` named after the project. Inside it, \`create_list\` for "Backlog", "In flight", and "Milestones" (or a single list if the project is small).
2. **Milestones first**: break the brief into 3–6 milestone tasks with due dates walking back from the deadline. Create them in Milestones with \`create_task\`, chained with \`add_dependency\` so order is explicit.
3. **First tasks**: decompose the first milestone into concrete tasks (each with a checklist of acceptance criteria). Assign starters.
4. **Kickoff doc**: \`create_doc\` titled "<Project>, brief" containing the goal, scope boundaries, milestone table, and links/ids of the milestone tasks.
5. **Recurring heartbeat**: \`create_scheduled_task\` for a weekly "<Project> status update" task assigned to yourself.
6. **Announce**: workspace-chat comment mentioning everyone involved, linking the doc and the first tasks.`,
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
5. Deliver as a workspace-chat comment (or \`create_doc\` if >40 lines) with sections: ✅ Shipped / 🏃 In flight / ⚠️ At risk / ⏭ Next.`,
  },
];

async function requireScopeMembership(
  ctx: QueryCtx | MutationCtx,
  scopeType: "user" | "workspace",
  scopeId: string,
): Promise<string> {
  const identity = await requireIdentity(ctx);
  if (scopeType === "user") {
    if (scopeId !== identity.subject) throw new Error("Forbidden");
  } else {
    const member = await ctx.db
      .query("memberships")
      .withIndex("by_user_and_workspace", (q) =>
        q
          .eq("userClerkId", identity.subject)
          .eq("workspaceId", scopeId as Id<"workspaces">),
      )
      .unique();
    if (!member) throw new Error("Forbidden");
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
    if (!slug) throw new Error("Slug is required");
    const existing = await ctx.db
      .query("skills")
      .withIndex("by_scope", (q) =>
        q.eq("scopeType", args.scopeType).eq("scopeId", args.scopeId),
      )
      .collect();
    if (existing.some((s) => s.slug === slug)) {
      throw new Error("A skill with this slug already exists");
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
    if (!skill) throw new Error("Skill not found");
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
