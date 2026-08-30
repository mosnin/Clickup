import { ConvexError, v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { requireIdentity } from "./_authz";
import { requireAgentByKey } from "./_agentAuth";
import { assertCanCreateAgent } from "./_adminEntitlements";
import { attenuate, clampFleetSize, type Envelope } from "./_envelope";
import { emitEvent } from "./events";
import {
  dispatchHostedMcp,
  hostedMcpMutationBuilder,
  hostedMcpQueryBuilder,
  type HostedMcpRegistry,
} from "./_hostedMcp";

const hostedMcpQueries: HostedMcpRegistry = new Map();
const hostedMcpMutations: HostedMcpRegistry = new Map();
const hostedMcpQuery = (name: string) =>
  hostedMcpQueryBuilder(hostedMcpQueries, name, query);
const hostedMcpMutation = (name: string) =>
  hostedMcpMutationBuilder(hostedMcpMutations, name, mutation);

export const _hostedMcpQuery = internalQuery({
  args: { operation: v.string(), apiKeyHash: v.string(), input: v.any() },
  handler: async (ctx, args): Promise<unknown> =>
    await dispatchHostedMcp(hostedMcpQueries, ctx, args),
});

export const _hostedMcpMutation = internalMutation({
  args: { operation: v.string(), apiKeyHash: v.string(), input: v.any() },
  handler: async (ctx, args): Promise<unknown> =>
    await dispatchHostedMcp(hostedMcpMutations, ctx, args),
});

// Fleet provisioning. See _envelope.ts for the rule everything here obeys.
//
// The credential is the orchestrator's own agent key: an agent that holds a
// grant may provision, one that doesn't may not. No second token type to
// mint, steal, rotate or explain.

function envelopeOf(grant: Doc<"agentGrants">): Envelope {
  return {
    role: grant.role,
    allowedListIds: grant.allowedListIds as string[] | undefined,
    dailyActionLimit: grant.dailyActionLimit,
    maxAgents: grant.maxAgents,
  };
}

async function activeGrantForHolder(
  ctx: QueryCtx | MutationCtx,
  agentId: Id<"agents">,
) {
  const grant = await ctx.db
    .query("agentGrants")
    .withIndex("by_holder", (q) => q.eq("holderAgentId", agentId))
    .filter((q) => q.eq(q.field("revokedAt"), undefined))
    .first();
  return grant;
}

async function fleetMembers(
  ctx: QueryCtx | MutationCtx,
  grantId: Id<"agentGrants">,
) {
  return await ctx.db
    .query("agents")
    .withIndex("by_grant", (q) => q.eq("provisionedByGrantId", grantId))
    .collect();
}

// ── The human's side ───────────────────────────────────────────────────

// Called from the consent screen when somebody chooses "let it run a fleet".
// Separate from approveDeviceRequest because a fleet can also be granted to
// an agent that already exists, long after it connected.
export const grantFleet = mutation({
  args: {
    holderAgentId: v.id("agents"),
    maxAgents: v.optional(v.number()),
    role: v.union(v.literal("member"), v.literal("readonly")),
    allowedListIds: v.optional(v.array(v.id("lists"))),
    dailyActionLimit: v.number(),
  },
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    const holder = await ctx.db.get(args.holderAgentId);
    if (!holder || holder.status !== "active") {
      throw new ConvexError("That agent is not available");
    }
    await requireFleetManage(ctx, holder, identity.subject);

    // One live grant per holder. A second would make "the envelope" ambiguous
    // and give an orchestrator a way to accumulate authority by asking twice.
    const existing = await activeGrantForHolder(ctx, holder._id);
    if (existing) {
      throw new ConvexError(
        "This agent already runs a fleet. Revoke it before granting another.",
      );
    }

    const maxAgents = clampFleetSize(args.maxAgents);
    const grantId = await ctx.db.insert("agentGrants", {
      parentType: holder.parentType,
      parentId: holder.parentId,
      holderAgentId: holder._id,
      clientName: holder.description ?? holder.name,
      role: args.role,
      allowedListIds:
        args.allowedListIds && args.allowedListIds.length > 0
          ? args.allowedListIds
          : undefined,
      dailyActionLimit: args.dailyActionLimit,
      maxAgents,
      grantedByClerkId: identity.subject,
      createdAt: Date.now(),
    });

    await emitEvent(ctx, {
      scopeType: holder.parentType,
      scopeId: holder.parentId,
      type: "fleet.granted",
      actor: { type: "user", id: identity.subject, name: identity.subject },
      entityType: "agent",
      entityId: holder._id,
      entityTitle: holder.name,
      payload: {
        maxAgents,
        role: args.role,
        dailyActionLimit: args.dailyActionLimit,
        restrictedToLists: args.allowedListIds?.length ?? 0,
      },
    });
    return { grantId, maxAgents };
  },
});

// One switch for the whole fleet. This is the half of the design that makes
// a grant SAFER than N individually-approved agents rather than merely more
// convenient: twenty separately-approved agents have twenty off switches and
// nobody finds all of them under pressure.
export const revokeFleet = mutation({
  args: { grantId: v.id("agentGrants") },
  handler: async (ctx, { grantId }) => {
    const identity = await requireIdentity(ctx);
    const grant = await ctx.db.get(grantId);
    if (!grant) throw new ConvexError("No such grant");
    if (grant.revokedAt !== undefined)
      return { revoked: 0, alreadyRevoked: true };
    const holder = await ctx.db.get(grant.holderAgentId);
    await requireFleetManage(ctx, holder ?? grant, identity.subject);

    const now = Date.now();
    await ctx.db.patch(grantId, {
      revokedAt: now,
      revokedByClerkId: identity.subject,
    });

    // Pausing is not enough on its own — a paused agent still holds a valid
    // key — so the keys go too. Deleting the key is the actual revocation;
    // the pause is what makes the Agents page tell the truth about it.
    const members = await fleetMembers(ctx, grantId);
    for (const member of members) {
      await ctx.db.patch(member._id, { status: "paused" });
      const keys = await ctx.db
        .query("agentKeys")
        .withIndex("by_agent", (q) => q.eq("agentId", member._id))
        .collect();
      for (const key of keys) await ctx.db.delete(key._id);
    }

    await emitEvent(ctx, {
      scopeType: grant.parentType,
      scopeId: grant.parentId,
      type: "fleet.revoked",
      actor: { type: "user", id: identity.subject, name: identity.subject },
      entityType: "agent",
      entityId: grant.holderAgentId,
      entityTitle: holder?.name ?? "Fleet",
      payload: { revokedAgents: members.length },
    });
    return { revoked: members.length, alreadyRevoked: false };
  },
});

// The fleet view: every grant in scope with its members and headroom.
export const listForScope = query({
  args: {
    parentType: v.union(v.literal("user"), v.literal("workspace")),
    parentId: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    if (
      !(await canSeeScope(
        ctx,
        args.parentType,
        args.parentId,
        identity.subject,
      ))
    ) {
      return [];
    }
    const grants = await ctx.db
      .query("agentGrants")
      .withIndex("by_scope", (q) =>
        q.eq("parentType", args.parentType).eq("parentId", args.parentId),
      )
      .collect();

    return await Promise.all(
      grants.map(async (grant) => {
        const members = await fleetMembers(ctx, grant._id);
        const holder = await ctx.db.get(grant.holderAgentId);
        return {
          grantId: grant._id,
          holderAgentId: grant.holderAgentId,
          holderName: holder?.name ?? "Unknown",
          role: grant.role,
          dailyActionLimit: grant.dailyActionLimit,
          maxAgents: grant.maxAgents,
          restrictedToLists: grant.allowedListIds?.length ?? 0,
          revokedAt: grant.revokedAt ?? null,
          grantedByClerkId: grant.grantedByClerkId,
          createdAt: grant.createdAt,
          members: members.map((member) => ({
            agentId: member._id,
            name: member.name,
            status: member.status,
            role: member.role ?? "member",
            lastSeenAt: member.lastSeenAt ?? null,
          })),
          // Live agents against the ceiling, so "can it still grow" is a
          // fact on the screen rather than something to work out.
          activeCount: members.filter((m) => m.status === "active").length,
        };
      }),
    );
  },
});

// ── The agent's side ───────────────────────────────────────────────────

// provision_agent over MCP. The orchestrator names a worker and asks for
// governance; what it gets is the intersection with its grant.
export const provisionAgent = hostedMcpMutation("provisionAgent")({
  args: {
    apiKey: v.string(),
    name: v.string(),
    description: v.optional(v.string()),
    capabilities: v.optional(v.array(v.string())),
    role: v.optional(v.union(v.literal("member"), v.literal("readonly"))),
    allowedListIds: v.optional(v.array(v.id("lists"))),
    dailyActionLimit: v.optional(v.number()),
    // Generated by the caller of this mutation (the MCP route) so the
    // plaintext key never exists in the database — same shape the device
    // grant uses.
    keyHash: v.string(),
    keyPrefix: v.string(),
  },
  handler: async (ctx, args) => {
    // "write" mode: provisioning counts against the orchestrator's own daily
    // budget and burst cap, so a runaway loop minting agents is stopped by
    // the limits that already exist rather than needing a new one.
    const { agent: holder } = await requireAgentByKey(
      ctx,
      args.apiKey,
      "write",
    );
    const grant = await activeGrantForHolder(ctx, holder._id);
    if (!grant) {
      throw new ConvexError(
        "This agent may not provision others. A human must grant it a fleet first.",
      );
    }

    const members = await fleetMembers(ctx, grant._id);
    // Counted over live members, so revoking or pausing a worker frees a
    // slot. Counting every member ever created would make a long-running
    // fleet that churns workers hit a ceiling it is not actually at.
    const live = members.filter((m) => m.status === "active").length;
    if (live >= grant.maxAgents) {
      throw new ConvexError(
        `Fleet is at its limit (${grant.maxAgents} agents). Pause one or ask a human to raise it.`,
      );
    }
    // Platform-wide free-tier cap (when configured). Complimentary
    // admin-owned scopes skip it; the grant's own maxAgents still binds.
    await assertCanCreateAgent(ctx, grant.parentType, grant.parentId);

    const name = args.name.trim().slice(0, 80);
    if (!name) throw new ConvexError("Agent name is required");

    const governance = attenuate(envelopeOf(grant), {
      role: args.role,
      allowedListIds: args.allowedListIds as string[] | undefined,
      dailyActionLimit: args.dailyActionLimit,
    });

    const now = Date.now();
    const agentId = await ctx.db.insert("agents", {
      name,
      description: args.description?.slice(0, 280),
      capabilities:
        args.capabilities && args.capabilities.length > 0
          ? args.capabilities.slice(0, 20)
          : undefined,
      parentType: grant.parentType,
      parentId: grant.parentId,
      status: "active",
      role: governance.role,
      allowedListIds: governance.allowedListIds as Id<"lists">[] | undefined,
      dailyActionLimit: governance.dailyActionLimit,
      provisionedByGrantId: grant._id,
      // Attributed to the human who granted the fleet, not to the machine
      // that ran the provision: they are the one who is accountable for it.
      createdByClerkId: grant.grantedByClerkId,
      createdAt: now,
    });
    await ctx.db.insert("agentKeys", {
      agentId,
      keyHash: args.keyHash,
      keyPrefix: args.keyPrefix,
      createdAt: now,
    });

    await emitEvent(ctx, {
      scopeType: grant.parentType,
      scopeId: grant.parentId,
      type: "fleet.provisioned",
      actor: { type: "agent", id: holder._id, name: holder.name },
      entityType: "agent",
      entityId: agentId,
      entityTitle: name,
      payload: {
        role: governance.role,
        dailyActionLimit: governance.dailyActionLimit,
        restrictedToLists: governance.allowedListIds?.length ?? 0,
        fleetSize: live + 1,
        maxAgents: grant.maxAgents,
        // Whether the request was narrowed, so an orchestrator asking for
        // more than it may have is visible rather than silently trimmed.
        narrowed:
          governance.role !== (args.role ?? governance.role) ||
          governance.dailyActionLimit !==
            (args.dailyActionLimit ?? governance.dailyActionLimit),
      },
    });

    return {
      agentId,
      name,
      role: governance.role,
      dailyActionLimit: governance.dailyActionLimit,
      allowedListIds: governance.allowedListIds ?? null,
      fleetRemaining: grant.maxAgents - (live + 1),
    };
  },
});

// What an orchestrator is allowed to do, for its own planning. Returns null
// rather than throwing when there is no grant: "may I provision" is a
// reasonable question to ask and a no is an answer, not an error.
export const myFleet = hostedMcpQuery("myFleet")({
  args: { apiKey: v.string() },
  handler: async (ctx, { apiKey }) => {
    const { agent } = await requireAgentByKey(ctx, apiKey);
    const grant = await activeGrantForHolder(ctx, agent._id);
    if (!grant) return null;
    const members = await fleetMembers(ctx, grant._id);
    const live = members.filter((m) => m.status === "active");
    return {
      maxAgents: grant.maxAgents,
      activeCount: live.length,
      remaining: grant.maxAgents - live.length,
      ceiling: {
        role: grant.role,
        dailyActionLimit: grant.dailyActionLimit,
        restrictedToLists: grant.allowedListIds?.length ?? 0,
      },
      members: live.map((m) => ({
        agentId: m._id,
        name: m.name,
        role: m.role ?? "member",
        lastSeenAt: m.lastSeenAt ?? null,
        currentTaskId: m.currentTaskId ?? null,
      })),
    };
  },
});

// ── Access ─────────────────────────────────────────────────────────────

// Granting a fleet is strictly more consequential than creating one agent,
// so it takes the same bar as minting a key by hand and never a softer one.
async function requireFleetManage(
  ctx: MutationCtx,
  scoped: { parentType: "user" | "workspace"; parentId: string },
  subject: string,
) {
  if (scoped.parentType === "user") {
    if (scoped.parentId !== subject) throw new ConvexError("Forbidden");
    return;
  }
  const membership = await ctx.db
    .query("memberships")
    .withIndex("by_user_and_workspace", (q) =>
      q
        .eq("userClerkId", subject)
        .eq("workspaceId", scoped.parentId as Id<"workspaces">),
    )
    .unique();
  if (!membership) throw new ConvexError("Forbidden");
  if (membership.role !== "owner" && membership.role !== "admin") {
    throw new ConvexError("Only workspace owners and admins can run a fleet");
  }
}

async function canSeeScope(
  ctx: QueryCtx,
  parentType: "user" | "workspace",
  parentId: string,
  subject: string,
) {
  if (parentType === "user") return parentId === subject;
  return (
    (await ctx.db
      .query("memberships")
      .withIndex("by_user_and_workspace", (q) =>
        q
          .eq("userClerkId", subject)
          .eq("workspaceId", parentId as Id<"workspaces">),
      )
      .unique()) !== null
  );
}
