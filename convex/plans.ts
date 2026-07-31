import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { requireIdentity, requireProjectAccess } from "./_authz";
import { emitEvent } from "./events";

// The plan: what we don't know, what could be true, what we know, what we chose.
//
// `src/lib/plan.ts` holds the model and the whole derivation — this file only
// writes rows and reads them back flat. Deliberately: question state is what
// the shape *means*, so it must be computed in exactly one place or a person
// and an agent will disagree about whether something is settled.
//
// **Shape is enforced on write.** Unlike a panel — a view somebody can shrug
// at, repaired on read — a malformed plan misrepresents what a team agreed.
// Evidence filed under a question rather than an option is evidence for
// nothing, so `attach` refuses it rather than normalizing it away later.
//
// **One core per act, shared with the agent surface.** The house rule: agents
// and people run the same code, so consent rules, events and shape checks
// cannot drift between them. The only thing that differs is the actor, and the
// one place it matters is closing a question — see `decideCore`.

export type PlanActor = {
  type: "user" | "agent" | "system";
  id: string;
  name: string;
};

const STANCE = v.union(
  v.literal("supports"),
  v.literal("refutes"),
  v.literal("neutral"),
);

/** What each kind must hang off. Mirrors `parentKindFor` in the pure lib. */
const PARENT_KIND = {
  question: null,
  option: "question",
  evidence: "option",
  decision: "question",
} as const;

async function scopeOfProject(
  ctx: QueryCtx | MutationCtx,
  project: Doc<"projects">,
): Promise<{ scopeType: "user" | "workspace"; scopeId: string }> {
  const space = await ctx.db.get(project.spaceId);
  if (!space) throw new ConvexError("Orphan project");
  return {
    scopeType: space.parentType === "workspace" ? "workspace" : "user",
    scopeId: space.parentId,
  };
}

/**
 * Resolve a parent and confirm the child may hang off it.
 *
 * Also confirms the parent is in the project being written to, so a node id
 * from one plan cannot graft a subtree onto another.
 */
async function attach(
  ctx: MutationCtx,
  projectId: Id<"projects">,
  kind: keyof typeof PARENT_KIND,
  parentId: Id<"planNodes"> | undefined,
): Promise<Doc<"planNodes"> | null> {
  const wanted = PARENT_KIND[kind];
  if (wanted === null) return null;
  if (!parentId) throw new ConvexError(`A ${kind} needs a ${wanted}`);
  const parent = await ctx.db.get(parentId);
  if (!parent || parent.projectId !== projectId) {
    throw new ConvexError(`That ${wanted} is not in this plan`);
  }
  if (parent.kind !== wanted) {
    throw new ConvexError(`A ${kind} hangs off a ${wanted}, not a ${parent.kind}`);
  }
  if (parent.retractedAt !== undefined) {
    throw new ConvexError(`That ${wanted} was retracted`);
  }
  return parent;
}

function body(text: string, what: string): string {
  const trimmed = text.trim().slice(0, 600);
  if (!trimmed) throw new ConvexError(`A ${what} needs something written in it`);
  return trimmed;
}

// ── Cores ───────────────────────────────────────────────────────────────

export async function addNodeCore(
  ctx: MutationCtx,
  args: {
    projectId: Id<"projects">;
    kind: "question" | "option" | "evidence";
    parentId?: Id<"planNodes">;
    body: string;
    needsHuman?: boolean;
    stance?: "supports" | "refutes" | "neutral";
    ref?: { kind: string; id: string };
    actor: PlanActor;
  },
): Promise<Id<"planNodes">> {
  const project = await ctx.db.get(args.projectId);
  if (!project) throw new ConvexError("Project not found");
  const scope = await scopeOfProject(ctx, project);
  await attach(ctx, args.projectId, args.kind, args.parentId);

  const nodeId = await ctx.db.insert("planNodes", {
    projectId: args.projectId,
    ...scope,
    kind: args.kind,
    parentId: args.parentId,
    body: body(args.body, args.kind),
    authorType: args.actor.type,
    authorId: args.actor.id,
    authorName: args.actor.name,
    createdAt: Date.now(),
    needsHuman: args.kind === "question" ? args.needsHuman === true : undefined,
    stance: args.kind === "evidence" ? (args.stance ?? "neutral") : undefined,
    ref: args.ref,
  });

  // A question is the only one worth telling the room about. Every option and
  // every piece of evidence would be the transcript this replaces.
  if (args.kind === "question") {
    await emitEvent(ctx, {
      scopeType: scope.scopeType,
      scopeId: scope.scopeId,
      type: "question.opened",
      actor: args.actor,
      entityType: "project",
      entityId: args.projectId,
      entityTitle: args.body.slice(0, 120),
    });
  }
  return nodeId;
}

/**
 * Settle a question, or ask to.
 *
 * The one place the actor changes the outcome. A question marked `needsHuman`
 * cannot be closed by a machine — an agent's decision lands unaccepted and
 * shows as "waiting on you" until a person accepts it. Same consent shape as
 * approval gates, layout proposals and panel proposals; a plan is not the
 * exception just because the artifact is a sentence rather than a task.
 */
export async function decideCore(
  ctx: MutationCtx,
  args: {
    questionId: Id<"planNodes">;
    chosenOptionId?: Id<"planNodes">;
    body: string;
    actor: PlanActor;
  },
): Promise<{ nodeId: Id<"planNodes">; accepted: boolean }> {
  const question = await ctx.db.get(args.questionId);
  if (!question || question.kind !== "question") {
    throw new ConvexError("Question not found");
  }
  if (question.retractedAt !== undefined) {
    throw new ConvexError("That question was retracted");
  }
  const project = await ctx.db.get(question.projectId);
  if (!project) throw new ConvexError("Project not found");
  const scope = await scopeOfProject(ctx, project);

  if (args.chosenOptionId) {
    const option = await ctx.db.get(args.chosenOptionId);
    if (
      !option ||
      option.kind !== "option" ||
      option.parentId !== args.questionId
    ) {
      throw new ConvexError("That option is not one of this question's answers");
    }
    if (option.retractedAt !== undefined) {
      throw new ConvexError("That option was retracted");
    }
  }

  const accepted = !(question.needsHuman === true && args.actor.type !== "user");
  const now = Date.now();
  const nodeId = await ctx.db.insert("planNodes", {
    projectId: question.projectId,
    ...scope,
    kind: "decision",
    parentId: args.questionId,
    chosenOptionId: args.chosenOptionId,
    body: body(args.body, "decision"),
    authorType: args.actor.type,
    authorId: args.actor.id,
    authorName: args.actor.name,
    createdAt: now,
    acceptedAt: accepted ? now : undefined,
    acceptedByClerkId: accepted && args.actor.type === "user" ? args.actor.id : undefined,
    acceptedByName: accepted ? args.actor.name : undefined,
  });

  await emitEvent(ctx, {
    scopeType: scope.scopeType,
    scopeId: scope.scopeId,
    type: accepted ? "question.decided" : "question.decision_proposed",
    actor: args.actor,
    entityType: "project",
    entityId: question.projectId,
    entityTitle: question.body.slice(0, 120),
    payload: { decision: args.body.slice(0, 200) },
  });

  return { nodeId, accepted };
}

// ── Reading ─────────────────────────────────────────────────────────────

/**
 * The whole plan, flat.
 *
 * Flat on purpose: `planView` in the pure lib builds the tree and derives every
 * status, and it is shared by the UI and by an agent's `read_plan`. Shipping a
 * pre-built tree from here would put a second derivation on the server that
 * nothing tests against the first.
 */
export const forProject = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, { projectId }) => {
    try {
      await requireProjectAccess(ctx, projectId);
    } catch {
      return [];
    }
    const rows = await ctx.db
      .query("planNodes")
      .withIndex("by_project", (q) => q.eq("projectId", projectId))
      .collect();
    return rows.map((r) => ({
      id: r._id as string,
      kind: r.kind,
      parentId: (r.parentId as string | undefined) ?? null,
      body: r.body,
      authorType: r.authorType,
      authorId: r.authorId,
      authorName: r.authorName,
      createdAt: r.createdAt,
      needsHuman: r.needsHuman === true,
      stance: r.stance ?? "neutral",
      chosenOptionId: (r.chosenOptionId as string | undefined) ?? null,
      acceptedAt: r.acceptedAt ?? null,
      acceptedByName: r.acceptedByName ?? null,
      ref: r.ref ?? null,
      retractedAt: r.retractedAt ?? null,
      retractedByName: r.retractedByName ?? null,
    }));
  },
});

// ── Human mutations ─────────────────────────────────────────────────────

async function actorFor(ctx: MutationCtx): Promise<PlanActor> {
  const identity = await requireIdentity(ctx);
  const user = await ctx.db
    .query("users")
    .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
    .unique();
  return {
    type: "user",
    id: identity.subject,
    name: user?.name || user?.email || "Someone",
  };
}

export const ask = mutation({
  args: {
    projectId: v.id("projects"),
    body: v.string(),
    /** Raising the gate: no agent may close this one. */
    needsHuman: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    await requireProjectAccess(ctx, args.projectId);
    return await addNodeCore(ctx, {
      projectId: args.projectId,
      kind: "question",
      body: args.body,
      needsHuman: args.needsHuman,
      actor: await actorFor(ctx),
    });
  },
});

export const addOption = mutation({
  args: { questionId: v.id("planNodes"), body: v.string() },
  handler: async (ctx, args) => {
    const question = await ctx.db.get(args.questionId);
    if (!question) throw new ConvexError("Question not found");
    await requireProjectAccess(ctx, question.projectId);
    return await addNodeCore(ctx, {
      projectId: question.projectId,
      kind: "option",
      parentId: args.questionId,
      body: args.body,
      actor: await actorFor(ctx),
    });
  },
});

export const addEvidence = mutation({
  args: {
    optionId: v.id("planNodes"),
    body: v.string(),
    stance: STANCE,
    ref: v.optional(v.object({ kind: v.string(), id: v.string() })),
  },
  handler: async (ctx, args) => {
    const option = await ctx.db.get(args.optionId);
    if (!option) throw new ConvexError("Option not found");
    await requireProjectAccess(ctx, option.projectId);
    return await addNodeCore(ctx, {
      projectId: option.projectId,
      kind: "evidence",
      parentId: args.optionId,
      body: args.body,
      stance: args.stance,
      ref: args.ref,
      actor: await actorFor(ctx),
    });
  },
});

export const decide = mutation({
  args: {
    questionId: v.id("planNodes"),
    chosenOptionId: v.optional(v.id("planNodes")),
    body: v.string(),
  },
  handler: async (ctx, args) => {
    const question = await ctx.db.get(args.questionId);
    if (!question) throw new ConvexError("Question not found");
    await requireProjectAccess(ctx, question.projectId);
    return await decideCore(ctx, { ...args, actor: await actorFor(ctx) });
  },
});

/** Sign off on a decision an agent proposed. */
export const acceptDecision = mutation({
  args: { decisionId: v.id("planNodes") },
  handler: async (ctx, { decisionId }) => {
    const decision = await ctx.db.get(decisionId);
    if (!decision || decision.kind !== "decision") {
      throw new ConvexError("Decision not found");
    }
    if (decision.acceptedAt !== undefined) {
      throw new ConvexError("That was already accepted");
    }
    await requireProjectAccess(ctx, decision.projectId);
    const actor = await actorFor(ctx);
    await ctx.db.patch(decisionId, {
      acceptedAt: Date.now(),
      acceptedByClerkId: actor.id,
      acceptedByName: actor.name,
    });
    await emitEvent(ctx, {
      scopeType: decision.scopeType,
      scopeId: decision.scopeId,
      type: "question.decided",
      actor,
      entityType: "project",
      entityId: decision.projectId,
      entityTitle: decision.body.slice(0, 120),
    });
  },
});

/**
 * Take something back without erasing it.
 *
 * Retracting a decision is how a question is reopened — the derivation stops
 * seeing it and the question drops back to whatever its options say. That is
 * the whole reopen mechanism: no separate verb, and the record of having once
 * decided the other way survives, which is the part a transcript gets right
 * and a status field gets wrong.
 */
export const retract = mutation({
  args: { nodeId: v.id("planNodes") },
  handler: async (ctx, { nodeId }) => {
    const node = await ctx.db.get(nodeId);
    if (!node) throw new ConvexError("Not found");
    await requireProjectAccess(ctx, node.projectId);
    if (node.retractedAt !== undefined) return;
    const actor = await actorFor(ctx);
    await ctx.db.patch(nodeId, {
      retractedAt: Date.now(),
      retractedByName: actor.name,
    });
  },
});

/** Put a retracted node back. Undo, for a mis-click on something durable. */
export const unretract = mutation({
  args: { nodeId: v.id("planNodes") },
  handler: async (ctx, { nodeId }) => {
    const node = await ctx.db.get(nodeId);
    if (!node) throw new ConvexError("Not found");
    await requireProjectAccess(ctx, node.projectId);
    await ctx.db.patch(nodeId, {
      retractedAt: undefined,
      retractedByName: undefined,
    });
  },
});
