import type { QueryCtx, MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";

// Platform-administration authorization (SOC2).
//
// Root of trust: the PLATFORM_ADMIN_EMAILS deployment env var — a
// comma-separated allowlist set out of band (never through the app).
// Anyone on that list is a superadmin. Superadmins may grant scoped
// `platformAdmins` rows to others; those rows are the second tier.
//
// There is deliberately NO in-app path for a normal end-user to escalate
// into this table: grants require an existing superadmin, and the env
// allowlist can only be edited by whoever controls the Convex deployment.
// Every grant, revoke, and privileged action is written to adminAuditLog.

export type AdminRole = "superadmin" | "support";

export type Admin = {
  clerkId: string;
  email: string;
  role: AdminRole;
  // True when authority comes from the env allowlist rather than a row.
  viaEnv: boolean;
};

function envAllowlist(): string[] {
  const raw = process.env.PLATFORM_ADMIN_EMAILS ?? "";
  return raw
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function isEmailRootAdmin(email: string | undefined | null): boolean {
  if (!email) return false;
  return envAllowlist().includes(email.toLowerCase());
}

async function currentUser(
  ctx: QueryCtx | MutationCtx,
): Promise<{ subject: string; user: Doc<"users"> | null; email: string }> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Not authenticated");
  const user = await ctx.db
    .query("users")
    .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
    .unique();
  // A suspended account is an admin hold: it must revoke admin powers too,
  // not just normal app writes. Without this, an admin whose account is
  // suspended (e.g. a rogue/compromised granted admin) could keep calling
  // grantAdmin/suspendUser/inspectWorkspace because the admin path doesn't
  // route through _authz.requireIdentity. Enforce it at the single choke
  // point every admin function resolves through.
  if (user?.suspendedAt) {
    throw new Error("Account suspended");
  }
  // Prefer the mirrored (webhook-verified) email for the env-allowlist
  // decision; the identity.email fallback only applies before the user row
  // has synced, and the Clerk JWT template must emit only verified primary
  // emails or that fallback would be spoofable.
  const email = (user?.email || identity.email || "").toLowerCase();
  return { subject: identity.subject, user, email };
}

// Resolves the caller to a platform admin or throws. `minRole: "superadmin"`
// restricts to the top tier (admin-roster + settings management).
export async function requirePlatformAdmin(
  ctx: QueryCtx | MutationCtx,
  opts?: { minRole?: AdminRole },
): Promise<Admin> {
  const { subject, email } = await currentUser(ctx);

  // Env-allowlisted → superadmin, no row required.
  if (isEmailRootAdmin(email)) {
    return { clerkId: subject, email, role: "superadmin", viaEnv: true };
  }

  const row = await ctx.db
    .query("platformAdmins")
    .withIndex("by_clerk_id", (q) => q.eq("clerkId", subject))
    .unique();
  if (!row || row.revokedAt) {
    throw new Error("Forbidden: platform admin access required");
  }
  if (opts?.minRole === "superadmin" && row.role !== "superadmin") {
    throw new Error("Forbidden: superadmin access required");
  }
  return {
    clerkId: subject,
    email: row.email,
    role: row.role,
    viaEnv: false,
  };
}

// Non-throwing check for gating the UI (server component / query). Returns
// null when the caller is not an admin.
export async function resolvePlatformAdmin(
  ctx: QueryCtx | MutationCtx,
): Promise<Admin | null> {
  try {
    return await requirePlatformAdmin(ctx);
  } catch {
    return null;
  }
}

// Append-only audit write. Call from admin MUTATIONS after the action
// succeeds (queries cannot write; sensitive reads that must be audited are
// modeled as mutations that log then return).
export async function logAdminAction(
  ctx: MutationCtx,
  admin: Admin,
  action: string,
  details?: {
    targetType?: string;
    targetId?: string;
    summary?: string;
    reason?: string;
    metadata?: unknown;
  },
): Promise<void> {
  await ctx.db.insert("adminAuditLog", {
    actorClerkId: admin.clerkId,
    actorEmail: admin.email,
    action,
    targetType: details?.targetType,
    targetId: details?.targetId,
    summary: details?.summary,
    reason: details?.reason,
    metadata: details?.metadata,
    createdAt: Date.now(),
  });
}
