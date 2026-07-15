import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";

// SOC2 security boundary tests for the platform-admin surface. These prove
// the properties that make the admin console safe: no privilege
// escalation, env-allowlist root of trust, complete audit trail, and
// least-privilege role separation.

const modules = import.meta.glob("../convex/**/*.*s");

const ROOT = { subject: "user_root", email: "root@company.com" };
const NORMAL = { subject: "user_normal", email: "normal@company.com" };
const SUPPORT = { subject: "user_support", email: "support@company.com" };

async function seedUsers(t: ReturnType<typeof convexTest>) {
  await t.run(async (ctx) => {
    for (const u of [ROOT, NORMAL, SUPPORT]) {
      await ctx.db.insert("users", { clerkId: u.subject, email: u.email });
    }
  });
}

describe("platform admin security", () => {
  beforeEach(() => {
    process.env.PLATFORM_ADMIN_EMAILS = "root@company.com";
  });
  afterEach(() => {
    delete process.env.PLATFORM_ADMIN_EMAILS;
  });

  it("treats the env allowlist as the root of trust", async () => {
    const t = convexTest(schema, modules);
    await seedUsers(t);
    const me = await t.withIdentity(ROOT).query(api.admin.me, {});
    expect(me?.role).toBe("superadmin");
    expect(me?.viaEnv).toBe(true);
  });

  it("denies non-admins entirely (no escalation path)", async () => {
    const t = convexTest(schema, modules);
    await seedUsers(t);
    const me = await t.withIdentity(NORMAL).query(api.admin.me, {});
    expect(me).toBeNull();
    // A normal user cannot read admin data…
    await expect(
      t.withIdentity(NORMAL).query(api.admin.overview, {}),
    ).rejects.toThrow(/platform admin/i);
    // …nor grant themselves admin.
    await expect(
      t
        .withIdentity(NORMAL)
        .mutation(api.admin.grantAdmin, {
          email: NORMAL.email,
          role: "superadmin",
        }),
    ).rejects.toThrow(/admin access required/i);
  });

  it("lets a superadmin grant scoped admin, and audits it", async () => {
    const t = convexTest(schema, modules);
    await seedUsers(t);
    await t
      .withIdentity(ROOT)
      .mutation(api.admin.grantAdmin, {
        email: SUPPORT.email,
        role: "support",
      });
    // Support admin can now read…
    const me = await t.withIdentity(SUPPORT).query(api.admin.me, {});
    expect(me?.role).toBe("support");
    // …but cannot grant (least privilege).
    await expect(
      t
        .withIdentity(SUPPORT)
        .mutation(api.admin.grantAdmin, {
          email: NORMAL.email,
          role: "support",
        }),
    ).rejects.toThrow(/superadmin/i);
    // The grant was recorded in the append-only audit log.
    const log = await t.withIdentity(ROOT).query(api.admin.auditLog, {});
    expect(log.some((r) => r.action === "admin.granted")).toBe(true);
  });

  it("blocks suspended users at the shared authz boundary", async () => {
    const t = convexTest(schema, modules);
    await seedUsers(t);
    await t
      .withIdentity(ROOT)
      .mutation(api.admin.suspendUser, {
        clerkId: NORMAL.subject,
        reason: "policy violation",
      });
    // The suspended user is now blocked from every write entry point.
    await expect(
      t.withIdentity(NORMAL).mutation(api.workspaces.create, { name: "X" }),
    ).rejects.toThrow(/suspended/i);
  });

  it("refuses to suspend a root admin", async () => {
    const t = convexTest(schema, modules);
    await seedUsers(t);
    await expect(
      t
        .withIdentity(ROOT)
        .mutation(api.admin.suspendUser, {
          clerkId: ROOT.subject,
          reason: "test",
        }),
    ).rejects.toThrow(/root/i);
  });
});
