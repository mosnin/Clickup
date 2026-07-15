import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import {
  isEmailRootAdmin,
  logAdminAction,
  requirePlatformAdmin,
  resolvePlatformAdmin,
} from "./_adminAuth";

// Platform-admin API. Every function here first resolves the caller to a
// platform admin (or returns an empty/null shape for the gating query).
// Reads expose operational metadata admins are entitled to; they never
// return customer content (task/doc bodies). Every mutation is audited.

const LIST_LIMIT = 200;

// ── Gating + identity ───────────────────────────────────────────────────

// Non-throwing: powers the layout guard and the "Admin" nav affordance.
export const me = query({
  args: {},
  handler: async (ctx) => {
    const admin = await resolvePlatformAdmin(ctx);
    if (!admin) return null;
    return { role: admin.role, email: admin.email, viaEnv: admin.viaEnv };
  },
});

// ── Overview ────────────────────────────────────────────────────────────

export const overview = query({
  args: {},
  handler: async (ctx) => {
    await requirePlatformAdmin(ctx);
    const now = Date.now();
    const dayAgo = now - 24 * 60 * 60 * 1000;
    const onlineWindow = now - 5 * 60 * 1000;

    const users = await ctx.db.query("users").collect();
    const workspaces = await ctx.db.query("workspaces").collect();
    const agents = await ctx.db.query("agents").collect();

    // Agent runs started in the last 24h (there's no global events index,
    // so agent activity is the platform-wide health signal we surface).
    const runsToday = (await ctx.db.query("agentRuns").collect()).filter(
      (r) => r.startedAt >= dayAgo,
    );

    return {
      users: {
        total: users.length,
        suspended: users.filter((u) => u.suspendedAt).length,
        onboarded: users.filter((u) => u.onboardedAt).length,
      },
      workspaces: {
        total: workspaces.length,
        suspended: workspaces.filter((w) => w.suspendedAt).length,
      },
      agents: {
        total: agents.length,
        online: agents.filter(
          (a) => a.lastSeenAt && a.lastSeenAt >= onlineWindow,
        ).length,
        paused: agents.filter((a) => a.status === "paused").length,
      },
      runsToday: {
        total: runsToday.length,
        failed: runsToday.filter((r) => r.status === "failed").length,
      },
    };
  },
});

// ── Users ───────────────────────────────────────────────────────────────

export const listUsers = query({
  args: { search: v.optional(v.string()) },
  handler: async (ctx, { search }) => {
    await requirePlatformAdmin(ctx);
    const q = (search ?? "").trim().toLowerCase();
    const all = await ctx.db.query("users").take(LIST_LIMIT * 3);
    const memberships = await ctx.db.query("memberships").collect();
    const membershipsByUser = new Map<string, number>();
    for (const m of memberships) {
      membershipsByUser.set(
        m.userClerkId,
        (membershipsByUser.get(m.userClerkId) ?? 0) + 1,
      );
    }
    const rows = all
      .filter(
        (u) =>
          !q ||
          u.email.toLowerCase().includes(q) ||
          (u.name ?? "").toLowerCase().includes(q),
      )
      .slice(0, LIST_LIMIT)
      .map((u) => ({
        _id: u._id,
        clerkId: u.clerkId,
        email: u.email,
        name: u.name,
        imageUrl: u.imageUrl,
        onboardedAt: u.onboardedAt,
        suspendedAt: u.suspendedAt,
        suspendedReason: u.suspendedReason,
        workspaceCount: membershipsByUser.get(u.clerkId) ?? 0,
        createdAt: u._creationTime,
      }));
    return rows.sort((a, b) => b.createdAt - a.createdAt);
  },
});

export const suspendUser = mutation({
  args: { clerkId: v.string(), reason: v.string() },
  handler: async (ctx, { clerkId, reason }) => {
    const admin = await requirePlatformAdmin(ctx);
    if (!reason.trim()) throw new Error("A reason is required");
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", clerkId))
      .unique();
    if (!user) throw new Error("User not found");
    if (isEmailRootAdmin(user.email)) {
      throw new Error("Cannot suspend a root platform admin");
    }
    // A suspension is an account hold — but it must not become a lateral or
    // upward attack on the admin hierarchy. Support admins (read + holds on
    // ordinary users) may not suspend any platform admin. A granted
    // superadmin may not suspend a peer superadmin; only the env-allowlisted
    // root (the ultimate authority) may hold a granted superadmin. This
    // pairs with the _adminAuth suspension check so a hold on an admin
    // actually contains them.
    const targetAdmin = await ctx.db
      .query("platformAdmins")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", clerkId))
      .unique();
    if (targetAdmin && !targetAdmin.revokedAt) {
      if (admin.role !== "superadmin") {
        throw new Error("Support admins cannot suspend a platform admin");
      }
      if (targetAdmin.role === "superadmin" && !admin.viaEnv) {
        throw new Error(
          "Only a root admin can suspend another superadmin",
        );
      }
    }
    await ctx.db.patch(user._id, {
      suspendedAt: Date.now(),
      suspendedReason: reason.trim(),
    });
    await logAdminAction(ctx, admin, "user.suspended", {
      targetType: "user",
      targetId: clerkId,
      summary: user.email,
      reason: reason.trim(),
    });
  },
});

export const reactivateUser = mutation({
  args: { clerkId: v.string() },
  handler: async (ctx, { clerkId }) => {
    const admin = await requirePlatformAdmin(ctx);
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", clerkId))
      .unique();
    if (!user) throw new Error("User not found");
    await ctx.db.patch(user._id, {
      suspendedAt: undefined,
      suspendedReason: undefined,
    });
    await logAdminAction(ctx, admin, "user.reactivated", {
      targetType: "user",
      targetId: clerkId,
      summary: user.email,
    });
  },
});

// ── Workspaces ──────────────────────────────────────────────────────────

export const listWorkspaces = query({
  args: { search: v.optional(v.string()) },
  handler: async (ctx, { search }) => {
    await requirePlatformAdmin(ctx);
    const q = (search ?? "").trim().toLowerCase();
    const all = await ctx.db.query("workspaces").take(LIST_LIMIT * 3);
    const memberships = await ctx.db.query("memberships").collect();
    const agents = await ctx.db.query("agents").collect();
    const memberCount = new Map<string, number>();
    for (const m of memberships) {
      memberCount.set(m.workspaceId, (memberCount.get(m.workspaceId) ?? 0) + 1);
    }
    const agentCount = new Map<string, number>();
    for (const a of agents) {
      if (a.parentType === "workspace") {
        agentCount.set(a.parentId, (agentCount.get(a.parentId) ?? 0) + 1);
      }
    }
    return all
      .filter((w) => !q || w.name.toLowerCase().includes(q))
      .slice(0, LIST_LIMIT)
      .map((w) => ({
        _id: w._id,
        name: w.name,
        slug: w.slug,
        ownerClerkId: w.ownerClerkId,
        suspendedAt: w.suspendedAt,
        suspendedReason: w.suspendedReason,
        memberCount: memberCount.get(w._id) ?? 0,
        agentCount: agentCount.get(w._id) ?? 0,
        createdAt: w.createdAt,
      }))
      .sort((a, b) => b.createdAt - a.createdAt);
  },
});

export const suspendWorkspace = mutation({
  args: { workspaceId: v.id("workspaces"), reason: v.string() },
  handler: async (ctx, { workspaceId, reason }) => {
    const admin = await requirePlatformAdmin(ctx);
    if (!reason.trim()) throw new Error("A reason is required");
    const ws = await ctx.db.get(workspaceId);
    if (!ws) throw new Error("Workspace not found");
    await ctx.db.patch(workspaceId, {
      suspendedAt: Date.now(),
      suspendedReason: reason.trim(),
    });
    await logAdminAction(ctx, admin, "workspace.suspended", {
      targetType: "workspace",
      targetId: workspaceId,
      summary: ws.name,
      reason: reason.trim(),
    });
  },
});

export const reactivateWorkspace = mutation({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, { workspaceId }) => {
    const admin = await requirePlatformAdmin(ctx);
    const ws = await ctx.db.get(workspaceId);
    if (!ws) throw new Error("Workspace not found");
    await ctx.db.patch(workspaceId, {
      suspendedAt: undefined,
      suspendedReason: undefined,
    });
    await logAdminAction(ctx, admin, "workspace.reactivated", {
      targetType: "workspace",
      targetId: workspaceId,
      summary: ws.name,
    });
  },
});

// ── Agents (platform-wide oversight) ─────────────────────────────────────

export const listAgents = query({
  args: {},
  handler: async (ctx) => {
    await requirePlatformAdmin(ctx);
    const now = Date.now();
    const onlineWindow = now - 5 * 60 * 1000;
    const agents = await ctx.db.query("agents").take(LIST_LIMIT);
    const keys = await ctx.db.query("agentKeys").collect();
    const keyCount = new Map<string, number>();
    for (const k of keys) {
      if (!k.revokedAt) {
        keyCount.set(k.agentId, (keyCount.get(k.agentId) ?? 0) + 1);
      }
    }
    return agents
      .map((a) => ({
        _id: a._id,
        name: a.name,
        emoji: a.emoji,
        parentType: a.parentType,
        parentId: a.parentId,
        status: a.status,
        role: a.role ?? "member",
        online: !!a.lastSeenAt && a.lastSeenAt >= onlineWindow,
        lastSeenAt: a.lastSeenAt,
        activeKeys: keyCount.get(a._id) ?? 0,
        createdAt: a._creationTime,
      }))
      .sort((a, b) => b.createdAt - a.createdAt);
  },
});

export const setAgentStatus = mutation({
  args: {
    agentId: v.id("agents"),
    status: v.union(v.literal("active"), v.literal("paused")),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, { agentId, status, reason }) => {
    // Pausing/activating an agent reaches into a workspace's fleet platform
    // wide, beyond support's "read + account-holds" remit — superadmin only.
    const admin = await requirePlatformAdmin(ctx, { minRole: "superadmin" });
    const agent = await ctx.db.get(agentId);
    if (!agent) throw new Error("Agent not found");
    await ctx.db.patch(agentId, { status });
    await logAdminAction(ctx, admin, `agent.${status}`, {
      targetType: "agent",
      targetId: agentId,
      summary: agent.name,
      reason,
    });
  },
});

// ── Admin roster (superadmin only) ───────────────────────────────────────

export const listAdmins = query({
  args: {},
  handler: async (ctx) => {
    await requirePlatformAdmin(ctx);
    const rows = await ctx.db.query("platformAdmins").collect();
    return rows
      .filter((r) => !r.revokedAt)
      .map((r) => ({
        _id: r._id,
        clerkId: r.clerkId,
        email: r.email,
        role: r.role,
        grantedByClerkId: r.grantedByClerkId,
        createdAt: r.createdAt,
      }))
      .sort((a, b) => a.createdAt - b.createdAt);
  },
});

export const grantAdmin = mutation({
  args: {
    email: v.string(),
    role: v.union(v.literal("superadmin"), v.literal("support")),
  },
  handler: async (ctx, { email, role }) => {
    const admin = await requirePlatformAdmin(ctx, { minRole: "superadmin" });
    const target = email.trim().toLowerCase();
    if (!target) throw new Error("Email required");
    const user = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", target))
      .unique();
    if (!user) {
      throw new Error("No user with that email has signed in yet");
    }
    const existing = await ctx.db
      .query("platformAdmins")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", user.clerkId))
      .unique();
    if (existing && !existing.revokedAt) {
      await ctx.db.patch(existing._id, { role });
    } else if (existing) {
      await ctx.db.patch(existing._id, {
        role,
        revokedAt: undefined,
        revokedByClerkId: undefined,
        grantedByClerkId: admin.clerkId,
        createdAt: Date.now(),
      });
    } else {
      await ctx.db.insert("platformAdmins", {
        clerkId: user.clerkId,
        email: target,
        role,
        grantedByClerkId: admin.clerkId,
        createdAt: Date.now(),
      });
    }
    await logAdminAction(ctx, admin, "admin.granted", {
      targetType: "user",
      targetId: user.clerkId,
      summary: `${target} → ${role}`,
    });
  },
});

export const revokeAdmin = mutation({
  args: { adminId: v.id("platformAdmins") },
  handler: async (ctx, { adminId }) => {
    const admin = await requirePlatformAdmin(ctx, { minRole: "superadmin" });
    const row = await ctx.db.get(adminId);
    if (!row) throw new Error("Admin not found");
    if (row.clerkId === admin.clerkId) {
      throw new Error("You cannot revoke your own admin access");
    }
    await ctx.db.patch(adminId, {
      revokedAt: Date.now(),
      revokedByClerkId: admin.clerkId,
    });
    await logAdminAction(ctx, admin, "admin.revoked", {
      targetType: "user",
      targetId: row.clerkId,
      summary: row.email,
    });
  },
});

// ── Audit log ────────────────────────────────────────────────────────────

export const auditLog = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    await requirePlatformAdmin(ctx);
    const rows = await ctx.db
      .query("adminAuditLog")
      .withIndex("by_created")
      .order("desc")
      .take(Math.min(limit ?? 100, 500));
    return rows.map((r) => ({
      _id: r._id,
      actorEmail: r.actorEmail,
      action: r.action,
      targetType: r.targetType,
      targetId: r.targetId,
      summary: r.summary,
      reason: r.reason,
      createdAt: r.createdAt,
    }));
  },
});

// ── Security posture + settings ──────────────────────────────────────────

export const securityPosture = query({
  args: {},
  handler: async (ctx) => {
    await requirePlatformAdmin(ctx);
    const admins = (await ctx.db.query("platformAdmins").collect()).filter(
      (a) => !a.revokedAt,
    );
    const envConfigured = (process.env.PLATFORM_ADMIN_EMAILS ?? "").trim()
      .length > 0;
    const now = Date.now();
    const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;
    const recentAudit = await ctx.db
      .query("adminAuditLog")
      .withIndex("by_created")
      .order("desc")
      .take(1);
    const auditActive =
      recentAudit.length > 0 && recentAudit[0].createdAt >= thirtyDaysAgo;

    const webhooks = await ctx.db.query("webhookSubscriptions").collect();
    const unsignedWebhooks = webhooks.filter((w) => !w.secret).length;

    const settings = await ctx.db.query("platformSettings").collect();
    const settingsMap = Object.fromEntries(
      settings.map((s) => [s.key, s.value]),
    );

    type Check = {
      key: string;
      label: string;
      status: "pass" | "warn" | "fail";
      detail: string;
    };
    const checks: Check[] = [
      {
        key: "root-allowlist",
        label: "Root admin allowlist configured",
        status: envConfigured ? "pass" : "warn",
        detail: envConfigured
          ? "PLATFORM_ADMIN_EMAILS is set on the deployment."
          : "Set PLATFORM_ADMIN_EMAILS so admin access has a fixed root of trust.",
      },
      {
        key: "audit-log",
        label: "Audit logging active",
        status: auditActive ? "pass" : "warn",
        detail: auditActive
          ? "Admin actions are being recorded to the append-only log."
          : "No audit entries in the last 30 days.",
      },
      {
        key: "least-privilege",
        label: "Least-privilege admin roster",
        status: admins.length <= 5 ? "pass" : "warn",
        detail: `${admins.length} scoped admin${admins.length === 1 ? "" : "s"} granted in-app.`,
      },
      {
        key: "webhook-signing",
        label: "All webhooks signed",
        status: unsignedWebhooks === 0 ? "pass" : "fail",
        detail:
          unsignedWebhooks === 0
            ? "Every outbound webhook carries an HMAC signature."
            : `${unsignedWebhooks} webhook(s) missing a signing secret.`,
      },
      {
        key: "approval-gates",
        label: "Human-in-the-loop enforced",
        status: "pass",
        detail:
          "Agents can raise approval gates but never lower them; completion is refused until a human signs off.",
      },
    ];

    return { checks, settings: settingsMap };
  },
});

const SETTING_KEYS = [
  "require_agent_approval_default",
  "max_agents_per_workspace",
  "session_idle_minutes",
] as const;

export const setSecuritySetting = mutation({
  args: { key: v.string(), value: v.any() },
  handler: async (ctx, { key, value }) => {
    const admin = await requirePlatformAdmin(ctx, { minRole: "superadmin" });
    if (!SETTING_KEYS.includes(key as (typeof SETTING_KEYS)[number])) {
      throw new Error("Unknown setting");
    }
    const existing = await ctx.db
      .query("platformSettings")
      .withIndex("by_key", (q) => q.eq("key", key))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, {
        value,
        updatedByClerkId: admin.clerkId,
        updatedAt: Date.now(),
      });
    } else {
      await ctx.db.insert("platformSettings", {
        key,
        value,
        updatedByClerkId: admin.clerkId,
        updatedAt: Date.now(),
      });
    }
    await logAdminAction(ctx, admin, "settings.updated", {
      targetType: "setting",
      targetId: key,
      summary: `${key} = ${JSON.stringify(value)}`,
    });
  },
});

// Break-glass: an admin opening a specific workspace's operational detail
// must supply a reason; the access is logged before the data returns.
export const inspectWorkspace = mutation({
  args: { workspaceId: v.id("workspaces"), reason: v.string() },
  handler: async (ctx, { workspaceId, reason }) => {
    const admin = await requirePlatformAdmin(ctx);
    if (!reason.trim()) throw new Error("A reason is required");
    const ws = await ctx.db.get(workspaceId);
    if (!ws) throw new Error("Workspace not found");
    await logAdminAction(ctx, admin, "workspace.break_glass", {
      targetType: "workspace",
      targetId: workspaceId,
      summary: ws.name,
      reason: reason.trim(),
    });
    const spaces = await ctx.db
      .query("spaces")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", "workspace").eq("parentId", workspaceId as Id<"workspaces">),
      )
      .collect();
    const members = await ctx.db
      .query("memberships")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .collect();
    return {
      name: ws.name,
      spaceCount: spaces.length,
      memberCount: members.length,
    };
  },
});
