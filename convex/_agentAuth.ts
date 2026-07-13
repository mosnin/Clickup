import type { QueryCtx, MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { getSpaceForList } from "./_authz";

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

export async function requireAgentByKey(
  ctx: QueryCtx | MutationCtx,
  apiKey: string,
): Promise<{ agent: Doc<"agents">; key: Doc<"agentKeys"> }> {
  const keyHash = sha256Hex(apiKey);
  const key = await ctx.db
    .query("agentKeys")
    .withIndex("by_hash", (q) => q.eq("keyHash", keyHash))
    .unique();
  if (!key || key.revokedAt !== undefined) {
    throw new Error("Invalid API key");
  }
  const agent = await ctx.db.get(key.agentId);
  if (!agent) throw new Error("Invalid API key");
  if (agent.status !== "active") throw new Error("Agent is paused");
  return { agent, key };
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
  if (!space) throw new Error("Space not found");
  if (!canAgentAccessSpace(space, agent)) throw new Error("Forbidden");
  return { space };
}

export async function requireFolderAccessForAgent(
  ctx: QueryCtx | MutationCtx,
  folderId: Id<"folders">,
  agent: Doc<"agents">,
): Promise<{ folder: Doc<"folders">; space: Doc<"spaces"> }> {
  const folder = await ctx.db.get(folderId);
  if (!folder) throw new Error("Folder not found");
  const space = await ctx.db.get(folder.spaceId);
  if (!space) throw new Error("Orphan folder");
  if (!canAgentAccessSpace(space, agent)) throw new Error("Forbidden");
  return { folder, space };
}

export async function requireListAccessForAgent(
  ctx: QueryCtx | MutationCtx,
  listId: Id<"lists">,
  agent: Doc<"agents">,
): Promise<{ list: Doc<"lists">; space: Doc<"spaces"> }> {
  const list = await ctx.db.get(listId);
  if (!list) throw new Error("List not found");
  const space = await getSpaceForList(ctx, list);
  if (!space) throw new Error("Orphan list");
  if (!canAgentAccessSpace(space, agent)) throw new Error("Forbidden");
  return { list, space };
}

export async function requireTaskAccessForAgent(
  ctx: QueryCtx | MutationCtx,
  taskId: Id<"tasks">,
  agent: Doc<"agents">,
): Promise<{ task: Doc<"tasks">; list: Doc<"lists">; space: Doc<"spaces"> }> {
  const task = await ctx.db.get(taskId);
  if (!task) throw new Error("Task not found");
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
    throw new Error("Forbidden");
  }
}
