import { ConvexError } from "convex/values";
import type { QueryCtx, MutationCtx, DatabaseWriter } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { getSpaceForList } from "./_authz";
import { buildPaymentRequired, paymentRequiredError, x402Config } from "./_x402";
import {
  ADMIN_BURST_LIMIT_PER_MINUTE,
  ADMIN_DAILY_ACTION_LIMIT,
  isComplimentaryScope,
} from "./_adminEntitlements";
import {
  oauthLegacyAuthorityKey,
  oauthResourcesMatch,
} from "./_oauthResource";

// Agent-side counterpart of _authz.ts. Human calls authenticate via Clerk
// (ctx.auth); agent calls authenticate via an API key passed as an argument
// to the functions in convex/agentApi.ts. Both funnel into the same
// hierarchy resolution: an agent can access a Space when the space lives
// inside the agent's own boundary (its owning user's personal space, or
// its workspace).

// A unified "who did this" value used for event emission and *ActorId
// columns. Users are identified by Clerk subject, agents by their document
// id, and "system" covers scheduler-driven writes.
export type Actor = {
  type: "user" | "agent" | "system";
  id: string;
  name: string;
};

// ── SHA-256 (pure JS) ──────────────────────────────────────────────────
// Convex queries/mutations run in a deterministic isolate without
// crypto.subtle, so API-key hashing uses this self-contained SHA-256.
// Key *generation* happens in a Node action (convex/agentKeys.ts) with a
// real CSPRNG; this hash only needs to match what that action stored.

/* eslint-disable no-bitwise */
const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

export function sha256Hex(input: string): string {
  const data = new TextEncoder().encode(input);
  const bitLen = data.length * 8;
  const padded = new Uint8Array((((data.length + 8) >> 6) << 6) + 64);
  padded.set(data);
  padded[data.length] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, Math.floor(bitLen / 2 ** 32));
  dv.setUint32(padded.length - 4, bitLen >>> 0);

  const h = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ];
  const w = new Uint32Array(64);
  for (let i = 0; i < padded.length; i += 64) {
    for (let t = 0; t < 16; t++) w[t] = dv.getUint32(i + t * 4);
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
      const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
    }
    let a = h[0], b = h[1], c = h[2], d = h[3];
    let e = h[4], f = h[5], g = h[6], hh = h[7];
    for (let t = 0; t < 64; t++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + S1 + ch + K[t] + w[t]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  }
  return h.map((x) => x.toString(16).padStart(8, "0")).join("");
}
/* eslint-enable no-bitwise */

// ── Key auth ───────────────────────────────────────────────────────────

// Mutations per UTC day before an agent is throttled, unless the agent
// row carries its own dailyActionLimit. Reads are not budgeted.
export const DEFAULT_DAILY_ACTION_LIMIT = 2000;

// Hard per-minute burst cap, independent of the daily budget: a runaway
// retry loop gets stopped in seconds instead of after burning a whole
// day's budget.
export const BURST_LIMIT_PER_MINUTE = 60;

function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

function utcMinute(): string {
  return new Date().toISOString().slice(0, 16);
}

// Authenticate an agent API key.
//
// mode:
//   "read"     (default) — no role check, no budget.
//   "write"    — rejects readonly agents, counts against the daily action
//                budget, and bumps the key's lastUsedAt. Only valid from
//                mutations.
//   "presence" — heartbeat-style calls: bumps lastUsedAt but is neither
//                role-gated nor budgeted, so a readonly or throttled agent
//                can still report liveness and read its inbox.
export async function requireAgentByKeyHash(
  ctx: QueryCtx | MutationCtx,
  keyHash: string,
  mode: "read" | "write" | "presence" = "read",
  expectedOAuthResource?: string,
): Promise<{
  agent: Doc<"agents">;
  key: Doc<"agentKeys"> | Doc<"oauthAccessTokens">;
}> {
  if (!/^[a-f0-9]{64}$/.test(keyHash)) {
    throw new ConvexError("Invalid API key");
  }
  const agentKey = await ctx.db
    .query("agentKeys")
    .withIndex("by_hash", (q) => q.eq("keyHash", keyHash))
    .unique();
  const oauthToken = agentKey
    ? null
    : await ctx.db
        .query("oauthAccessTokens")
        .withIndex("by_token_hash", (q) => q.eq("tokenHash", keyHash))
        .unique();
  const key = agentKey ?? oauthToken;
  if (
    !key ||
    key.revokedAt !== undefined ||
    (oauthToken !== null && oauthToken.expiresAt <= Date.now())
  ) {
    throw new ConvexError("Invalid API key");
  }
  if (oauthToken?.grantId) {
    const grant = await ctx.db
      .query("oauthTokenGrants")
      .withIndex("by_grant_id", (q) => q.eq("grantId", oauthToken.grantId!))
      .unique();
    if (!grant || grant.revokedAt !== undefined) {
      throw new ConvexError("Invalid API key");
    }
  } else if (oauthToken?.resource) {
    const authorityKey = oauthLegacyAuthorityKey({
      clientId: oauthToken.clientId,
      resource: oauthToken.resource,
      userClerkId: oauthToken.userClerkId,
      ...(oauthToken.agentId ? { agentId: oauthToken.agentId } : {}),
      ...(oauthToken.workspaceId
        ? { workspaceId: oauthToken.workspaceId }
        : {}),
    });
    const legacyRevocation = await ctx.db
      .query("oauthLegacyRevocations")
      .withIndex("by_authority_key", (q) =>
        q.eq("authorityKey", authorityKey),
      )
      .unique();
    if (
      legacyRevocation &&
      oauthToken.createdAt <= legacyRevocation.revokedBefore
    ) {
      throw new ConvexError("Invalid API key");
    }
  }
  // Company OS connector tokens are workspace-bound and deliberately have no
  // agent principal. They are never valid on the MCP/agent API surface.
  if (!key.agentId) throw new ConvexError("Invalid API key");
  const agent = await ctx.db.get(key.agentId);
  if (!agent) throw new ConvexError("Invalid API key");
  if (agent.status !== "active") throw new ConvexError("Agent is paused");
  if (oauthToken) {
    let stillAuthorized: boolean;
    if (agent.parentType === "user") {
      stillAuthorized = agent.parentId === oauthToken.userClerkId;
    } else {
      const workspaceId = agent.parentId as Id<"workspaces">;
      const [workspace, membership] = await Promise.all([
        ctx.db.get(workspaceId),
        ctx.db
          .query("memberships")
          .withIndex("by_user_and_workspace", (q) =>
            q
              .eq("userClerkId", oauthToken.userClerkId)
              .eq("workspaceId", workspaceId),
          )
          .unique(),
      ]);
      stillAuthorized =
        workspace?.ownerClerkId === oauthToken.userClerkId &&
        membership !== null;
    }
    if (!stillAuthorized) throw new ConvexError("OAuth access was revoked");
    if (
      expectedOAuthResource !== undefined &&
      !oauthResourcesMatch(oauthToken.resource, expectedOAuthResource)
    ) {
      throw new ConvexError("OAuth token audience does not match this resource");
    }
    if (!oauthToken.scopes.includes("operate:read")) {
      throw new ConvexError("OAuth token is missing operate:read");
    }
    if (
      mode !== "read" &&
      !oauthToken.scopes.includes("operate:write")
    ) {
      throw new ConvexError("OAuth token is missing operate:write");
    }
  }

  if (mode !== "read" && "patch" in ctx.db) {
    const db = (ctx as MutationCtx).db;
    // Throttle lastUsedAt writes to one per 5 minutes per key.
    if (
      key.lastUsedAt === undefined ||
      Date.now() - key.lastUsedAt > 5 * 60 * 1000
    ) {
      await db.patch(key._id, { lastUsedAt: Date.now() });
    }
    if (mode === "write") {
      if ((agent.role ?? "member") === "readonly") {
        throw new ConvexError("This agent is read-only");
      }

      // A human pulled the stop. Refused here rather than left to the wake
      // notice alone, because a stop that depends on the agent choosing to
      // read its inbox is a request, not a stop. Reads and presence still
      // work: a stopped agent must still be able to say where it got to.
      if (agent.stopRequestedAt !== undefined) {
        throw new ConvexError(
          agent.stopReason
            ? `Stopped by a human: ${agent.stopReason}. Work resumes when they clear the stop.`
            : "Stopped by a human. Work resumes when they clear the stop.",
        );
      }

      // ── Spend ceilings ──────────────────────────────────────────────────
      //
      // Money was the one budget that was charted and never enforced: writes
      // were counted, bursts were capped, and an agent could burn hundreds of
      // dollars of tokens inside three mutations. Two ceilings, because they
      // answer two different questions — "has this agent run away" and "has
      // my FLEET run away", and an agency owner only ever asks the second.
      //
      // It is a CIRCUIT BREAKER, not a pre-authorization. Cost is known when
      // a run finishes, never before an action starts, so the honest contract
      // is "you have already spent past your ceiling today, so you get no
      // further actions" — the next action is refused, not the one that
      // crossed the line. That is also why recording spend (finish_run) must
      // never itself be blocked by these: the money is already gone, and
      // refusing to write it down would only hide it.
      //
      // Self-reported input is a real limit on what this can promise. It
      // binds an honest agent completely and makes a dishonest one visible
      // (runs finishing with no cost attached is a fact somebody can read).
      // It is a safety rail, not a security boundary, and calling it anything
      // else would be a lie told to whoever sets the number.
      //
      // Checked BEFORE the daily/burst counters for the same reason the
      // credits check is: a refusal must not burn budget.
      const spendDay = utcDay();
      const agentSpendLimit = agent.dailySpendUsdLimit;
      if (agentSpendLimit !== undefined) {
        const usageRow = await db
          .query("agentUsage")
          .withIndex("by_agent_day", (q) =>
            q.eq("agentId", agent._id).eq("day", spendDay),
          )
          .unique();
        const spent = usageRow?.spendUsd ?? 0;
        if (spent >= agentSpendLimit) {
          throw new ConvexError(
            `Daily spend ceiling reached ($${spent.toFixed(2)} of ` +
              `$${agentSpendLimit.toFixed(2)}). This agent stops here until ` +
              `tomorrow, or until a human raises its limit.`,
          );
        }
      }

      const scopeWallet = await db
        .query("agentWallets")
        .withIndex("by_scope", (q) =>
          q.eq("scopeType", agent.parentType).eq("scopeId", agent.parentId),
        )
        .unique();
      if (scopeWallet?.dailySpendUsdLimit !== undefined) {
        // A counter from an older day is zero, not stale: the roll is read
        // rather than swept, so no cron is load-bearing for a money ceiling.
        const fleetSpent =
          scopeWallet.spendDay === spendDay
            ? (scopeWallet.spendUsdToday ?? 0)
            : 0;
        if (fleetSpent >= scopeWallet.dailySpendUsdLimit) {
          throw new ConvexError(
            `Fleet daily spend ceiling reached ($${fleetSpent.toFixed(2)} of ` +
              `$${scopeWallet.dailySpendUsdLimit.toFixed(2)}). Every agent in ` +
              `this space stops here until tomorrow, or until a human raises ` +
              `the limit.`,
          );
        }
      }

      // x402 metered credits. When platform metering is enabled, each write
      // action consumes credits from the agent's scope wallet. This runs
      // BEFORE the daily/burst counters so a payment-required refusal doesn't
      // burn budget. Insufficient balance raises a payment-required signal
      // carrying an x402 402 challenge the agent can settle to top up.
      //
      // Platform-admin scopes are complimentary: staff accounts are unpaid
      // and must keep working when metering is on. The extreme daily/burst
      // caps below are the rogue-agent safety net, not a bill.
      const complimentary = await isComplimentaryScope(
        ctx,
        agent.parentType,
        agent.parentId,
      );
      const meteringRow = await db
        .query("platformSettings")
        .withIndex("by_key", (q) => q.eq("key", "x402.metering"))
        .unique();
      const meteringOn =
        !complimentary &&
        (meteringRow?.value === "on" || meteringRow?.value === true);
      if (meteringOn) {
        const cfg = x402Config();
        const priceRow = await db
          .query("platformSettings")
          .withIndex("by_key", (q) => q.eq("key", "x402.actionCredits"))
          .unique();
        const price =
          typeof priceRow?.value === "number" && priceRow.value >= 0
            ? priceRow.value
            : cfg.actionCredits;
        if (price > 0) {
          const wallet = await db
            .query("agentWallets")
            .withIndex("by_scope", (q) =>
              q
                .eq("scopeType", agent.parentType)
                .eq("scopeId", agent.parentId),
            )
            .unique();
          const balance = wallet?.balance ?? 0;
          if (balance < price) {
            const suggested = Math.max(price, 1000);
            const challenge = buildPaymentRequired(
              suggested,
              `x402://credits/${agent.parentType}/${agent.parentId}`,
              cfg,
            );
            throw paymentRequiredError({
              message: `Insufficient credits: balance ${balance} < ${price} per action. Buy credits via x402 (buy_credits → settle_payment).`,
              balance,
              pricePerAction: price,
              ...challenge,
            });
          }
          // balance >= price > 0 guarantees the wallet row exists.
          await db.patch(wallet!._id, {
            balance: balance - price,
            lifetimeSpent: (wallet!.lifetimeSpent ?? 0) + price,
            updatedAt: Date.now(),
          });
        }
      }

      const day = utcDay();
      const minute = utcMinute();
      const usage = await db
        .query("agentUsage")
        .withIndex("by_agent_day", (q) =>
          q.eq("agentId", agent._id).eq("day", day),
        )
        .unique();
      // Complimentary scopes default to the staff ceiling. An explicit
      // per-agent budget still wins when it is *lower* (a human throttling
      // one agent); it cannot raise the circuit breaker.
      const requested = agent.dailyActionLimit ?? (
        complimentary ? ADMIN_DAILY_ACTION_LIMIT : DEFAULT_DAILY_ACTION_LIMIT
      );
      const limit = complimentary
        ? Math.min(requested, ADMIN_DAILY_ACTION_LIMIT)
        : requested;
      const burstLimit = complimentary
        ? ADMIN_BURST_LIMIT_PER_MINUTE
        : BURST_LIMIT_PER_MINUTE;
      const count = usage?.count ?? 0;
      if (count >= limit) {
        throw new ConvexError(
          `Daily action budget exhausted (${limit}/day). Ask a human to raise this agent's limit.`,
        );
      }
      const minuteCount =
        usage?.minute === minute ? (usage.minuteCount ?? 0) : 0;
      if (minuteCount >= burstLimit) {
        throw new ConvexError(
          `Rate limited (${burstLimit} actions/minute). Slow down and retry shortly.`,
        );
      }
      if (usage) {
        await db.patch(usage._id, {
          count: count + 1,
          minute,
          minuteCount: minuteCount + 1,
        });
      } else {
        await db.insert("agentUsage", {
          agentId: agent._id,
          day,
          count: 1,
          minute,
          minuteCount: 1,
        });
      }
    }
  }
  return { agent, key };
}

export async function requireAgentByKey(
  ctx: QueryCtx | MutationCtx,
  apiKey: string,
  mode: "read" | "write" | "presence" = "read",
  expectedOAuthResource?: string,
) {
  return await requireAgentByKeyHash(
    ctx,
    sha256Hex(apiKey),
    mode,
    expectedOAuthResource,
  );
}

// Structure-level operations (creating spaces/projects/lists, sprints,
// webhooks, skills) are off-limits to list-restricted agents — their
// world is exactly their allowed lists.
export function requireUnrestricted(agent: Doc<"agents">): void {
  if (agent.allowedListIds !== undefined) {
    throw new ConvexError("This agent is restricted to specific lists");
  }
}

export function agentCanTouchList(
  agent: Doc<"agents">,
  listId: Id<"lists">,
): boolean {
  return (
    agent.allowedListIds === undefined || agent.allowedListIds.includes(listId)
  );
}

export function agentActor(agent: Doc<"agents">): Actor {
  return { type: "agent", id: agent._id, name: agent.name };
}

// ── Hierarchy access ───────────────────────────────────────────────────

export function canAgentAccessSpace(
  space: Doc<"spaces">,
  agent: Doc<"agents">,
): boolean {
  return (
    space.parentType === agent.parentType && space.parentId === agent.parentId
  );
}

export async function requireSpaceAccessForAgent(
  ctx: QueryCtx | MutationCtx,
  spaceId: Id<"spaces">,
  agent: Doc<"agents">,
): Promise<{ space: Doc<"spaces"> }> {
  const space = await ctx.db.get(spaceId);
  if (!space) throw new ConvexError("Space not found");
  if (!canAgentAccessSpace(space, agent)) {
    throw new ConvexError(
      "You can't access this space — it's outside your agent's scope. Call whoami to see your scope, get_tree for what's visible.",
    );
  }
  return { space };
}

export async function requireProjectAccessForAgent(
  ctx: QueryCtx | MutationCtx,
  projectId: Id<"projects">,
  agent: Doc<"agents">,
): Promise<{ project: Doc<"projects">; space: Doc<"spaces"> }> {
  const project = await ctx.db.get(projectId);
  if (!project) throw new ConvexError("Project not found");
  const space = await ctx.db.get(project.spaceId);
  if (!space) throw new ConvexError("Orphan project");
  if (!canAgentAccessSpace(space, agent)) {
    throw new ConvexError(
      "You can't access this project — it's outside your agent's scope. Call whoami to see your scope, get_tree for what's visible.",
    );
  }
  return { project, space };
}

export async function requireListAccessForAgent(
  ctx: QueryCtx | MutationCtx,
  listId: Id<"lists">,
  agent: Doc<"agents">,
): Promise<{ list: Doc<"lists">; space: Doc<"spaces"> }> {
  const list = await ctx.db.get(listId);
  if (!list) throw new ConvexError("List not found");
  const space = await getSpaceForList(ctx, list);
  if (!space) throw new ConvexError("Orphan list");
  if (!canAgentAccessSpace(space, agent)) {
    throw new ConvexError(
      "You can't access this list — it may be outside your scope or excluded by your allow-list. Call whoami to see your allowed lists, get_tree for what's visible.",
    );
  }
  if (!agentCanTouchList(agent, listId)) {
    throw new ConvexError(
      "This agent is not allowed to touch this list — it's excluded by your allow-list. Call whoami to see your allowed lists.",
    );
  }
  return { list, space };
}

export async function requireTaskAccessForAgent(
  ctx: QueryCtx | MutationCtx,
  taskId: Id<"tasks">,
  agent: Doc<"agents">,
): Promise<{ task: Doc<"tasks">; list: Doc<"lists">; space: Doc<"spaces"> }> {
  const task = await ctx.db.get(taskId);
  if (!task) throw new ConvexError("Task not found");
  const { list, space } = await requireListAccessForAgent(
    ctx,
    task.listId,
    agent,
  );
  return { task, list, space };
}

export function requireWorkspaceAccessForAgent(
  workspaceId: Id<"workspaces">,
  agent: Doc<"agents">,
): void {
  if (agent.parentType !== "workspace" || agent.parentId !== workspaceId) {
    throw new ConvexError(
      "You can't act on this workspace — this agent is scoped to a different workspace or to a personal space. Call whoami to see your scope.",
    );
  }
}

/**
 * Record self-reported spend against today's ceilings.
 *
 * One writer, called wherever a run reports cost, so the per-agent counter
 * and the fleet counter can never disagree about the same dollar. It is
 * deliberately unconditional: the ceilings in `requireAgentByKey` refuse the
 * NEXT action, and refusing to write down money that has already been spent
 * would only hide the overrun from the person who set the limit.
 *
 * The fleet counter rolls by comparison rather than by sweep — a `spendDay`
 * from yesterday reads as zero — so no cron is load-bearing for a ceiling.
 */
export async function recordAgentSpend(
  ctx: { db: DatabaseWriter },
  agent: Doc<"agents">,
  costUsd: number,
): Promise<{ agentCrossed: boolean; fleetCrossed: boolean }> {
  const none = { agentCrossed: false, fleetCrossed: false };
  if (!Number.isFinite(costUsd) || costUsd <= 0) return none;
  const day = utcDay();

  const usage = await ctx.db
    .query("agentUsage")
    .withIndex("by_agent_day", (q) => q.eq("agentId", agent._id).eq("day", day))
    .unique();
  const before = usage?.spendUsd ?? 0;
  const after = before + costUsd;
  if (usage) {
    await ctx.db.patch(usage._id, { spendUsd: after });
  } else {
    await ctx.db.insert("agentUsage", {
      agentId: agent._id,
      day,
      count: 0,
      spendUsd: costUsd,
    });
  }
  // The CROSSING is the newsworthy moment, and this is the only place it can
  // be observed. A refusal cannot announce itself: `requireAgentByKey` throws,
  // and a Convex mutation that throws rolls back everything it wrote — an
  // event emitted on the refusal path would never commit. Reporting the
  // crossing here also means one signal per ceiling per day rather than one
  // per rejected attempt by an agent that keeps knocking.
  const agentLimit = agent.dailySpendUsdLimit;
  const agentCrossed =
    agentLimit !== undefined && before < agentLimit && after >= agentLimit;

  const wallet = await ctx.db
    .query("agentWallets")
    .withIndex("by_scope", (q) =>
      q.eq("scopeType", agent.parentType).eq("scopeId", agent.parentId),
    )
    .unique();
  let fleetCrossed = false;
  if (wallet) {
    const base = wallet.spendDay === day ? (wallet.spendUsdToday ?? 0) : 0;
    const fleetAfter = base + costUsd;
    await ctx.db.patch(wallet._id, {
      spendDay: day,
      spendUsdToday: fleetAfter,
    });
    const fleetLimit = wallet.dailySpendUsdLimit;
    fleetCrossed =
      fleetLimit !== undefined && base < fleetLimit && fleetAfter >= fleetLimit;
  }
  // No wallet row = this scope has never touched the money system, so there
  // is no fleet ceiling to count against. Minting one here would create a
  // wallet as a side effect of an agent finishing a run.
  return { agentCrossed, fleetCrossed };
}
