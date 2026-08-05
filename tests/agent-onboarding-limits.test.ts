import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import { CODE_LOOKUP_RULE, DEVICE_REQUEST_RULE } from "../convex/_rateLimit";

const modules = import.meta.glob("../convex/**/*.*s");

const OWNER = { subject: "limits_owner" };
const ATTACKER = { subject: "limits_attacker" };

// Valid glyphs only — see DEVICE_CODE_ALPHABET.
const CODES = [
  "AAAA-3333",
  "CCCC-4444",
  "DDDD-7777",
  "EEEE-9999",
  "FFFF-3344",
  "GGGG-4477",
];

async function setup() {
  const t = convexTest(schema, modules);
  const workspaceId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("workspaces", {
      name: "Limits",
      slug: "limits",
      ownerClerkId: OWNER.subject,
      createdAt: Date.now(),
    });
    await ctx.db.insert("memberships", {
      workspaceId: id,
      userClerkId: OWNER.subject,
      role: "owner",
      joinedAt: Date.now(),
    });
    return id;
  });
  return { t, workspaceId };
}

function code(index: number) {
  // Deterministic, well-formed, and distinct — enough distinct codes to walk
  // past any of the limits under test.
  const A = "ACDEFGHJKMNPQRTUVWXY3479";
  let out = "";
  let n = index;
  for (let i = 0; i < 8; i += 1) {
    out += A[n % A.length];
    n = Math.floor(n / A.length) + i;
  }
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

describe("device request flooding", () => {
  it("stops one host minting requests forever", async () => {
    const { t } = await setup();
    for (let i = 0; i < DEVICE_REQUEST_RULE.limit; i += 1) {
      await t.mutation(api.agentAuth.createDeviceRequest, {
        deviceCode: `opd_flood_${i}`,
        userCode: code(i),
        clientName: "flood",
        clientIp: "203.0.113.9",
      });
    }
    await expect(
      t.mutation(api.agentAuth.createDeviceRequest, {
        deviceCode: "opd_flood_over",
        userCode: code(999),
        clientName: "flood",
        clientIp: "203.0.113.9",
      }),
    ).rejects.toThrow(/too many/i);
  });

  it("buckets per address, so one flooder cannot lock everybody out", async () => {
    const { t } = await setup();
    for (let i = 0; i < DEVICE_REQUEST_RULE.limit; i += 1) {
      await t.mutation(api.agentAuth.createDeviceRequest, {
        deviceCode: `opd_a_${i}`,
        userCode: code(i),
        clientName: "flood",
        clientIp: "203.0.113.9",
      });
    }
    // A different address is a different budget — otherwise the limit is a
    // denial-of-service tool rather than a defence against one.
    await expect(
      t.mutation(api.agentAuth.createDeviceRequest, {
        deviceCode: "opd_b_1",
        userCode: code(500),
        clientName: "innocent",
        clientIp: "198.51.100.4",
      }),
    ).resolves.toMatchObject({ interval: expect.any(Number) });
  });
});

// The finding this exists for.
//
// requestForUserCode used to be an unthrottled authenticated query. Anybody
// with an account could sweep the user-code space, and a hit lets them bind
// THEIR agent in THEIR workspace to somebody else's pending device code — so
// the victim's runtime connects, with a valid key, to a workspace the
// attacker controls, and starts taking instructions from it.
describe("user-code enumeration", () => {
  it("locks out a sweep well before it can find a live code", async () => {
    const { t } = await setup();
    const attacker = t.withIdentity(ATTACKER);
    for (let i = 0; i < CODE_LOOKUP_RULE.limit; i += 1) {
      const result = await attacker.mutation(api.agentAuth.lookupUserCode, {
        userCode: code(i + 100),
      });
      expect(result.state).toBe("not_found");
    }
    await expect(
      attacker.mutation(api.agentAuth.lookupUserCode, {
        userCode: code(9999),
      }),
    ).rejects.toThrow(/too many/i);
  });

  it("counts guesses at approve too, so skipping the lookup is not a bypass", async () => {
    const { t, workspaceId } = await setup();
    const attacker = t.withIdentity(ATTACKER);
    for (let i = 0; i < CODE_LOOKUP_RULE.limit; i += 1) {
      // A miss RETURNS rather than throwing, so the counter increment
      // commits. Throwing here would roll the count back and the limit
      // would never engage — which is exactly what this test caught.
      const result = await attacker.mutation(
        api.agentAuth.approveDeviceRequest,
        {
          userCode: code(i + 200),
          parentType: "user",
          parentId: ATTACKER.subject,
          agentName: "Sweep",
          role: "member",
        },
      );
      expect(result).toMatchObject({ approved: false, reason: "invalid_code" });
    }
    await expect(
      attacker.mutation(api.agentAuth.approveDeviceRequest, {
        userCode: code(8888),
        parentType: "user",
        parentId: ATTACKER.subject,
        agentName: "Sweep",
        role: "member",
      }),
    ).rejects.toThrow(/too many/i);
    void workspaceId;
  });

  it("never spends a legitimate user's budget on correct codes", async () => {
    const { t, workspaceId } = await setup();
    const owner = t.withIdentity(OWNER);
    // Somebody connecting many agents in a row types each code correctly.
    // If successes were counted they would be locked out of their own
    // onboarding, which is the wrong half of the population to limit.
    for (let i = 0; i < CODE_LOOKUP_RULE.limit + 5; i += 1) {
      const userCode = code(i + 300);
      await t.mutation(api.agentAuth.createDeviceRequest, {
        deviceCode: `opd_ok_${i}`,
        userCode,
        clientName: "claude-code",
        clientIp: `198.51.100.${i % 200}`,
      });
      const found = await owner.mutation(api.agentAuth.lookupUserCode, {
        userCode,
      });
      expect(found.state).toBe("pending");
    }
    void workspaceId;
  });

  it("keeps the budget per caller", async () => {
    const { t } = await setup();
    const attacker = t.withIdentity(ATTACKER);
    for (let i = 0; i < CODE_LOOKUP_RULE.limit; i += 1) {
      await attacker.mutation(api.agentAuth.lookupUserCode, {
        userCode: code(i + 400),
      });
    }
    // The attacker being locked out must not lock out everyone else.
    await expect(
      t
        .withIdentity(OWNER)
        .mutation(api.agentAuth.lookupUserCode, { userCode: code(7777) }),
    ).resolves.toMatchObject({ state: "not_found" });
  });
});

describe("credential grants are audited", () => {
  it("logs the authorization and the key, with the blast radius attached", async () => {
    const { t, workspaceId } = await setup();
    const userCode = code(4242);
    await t.mutation(api.agentAuth.createDeviceRequest, {
      deviceCode: "opd_audit",
      userCode,
      clientName: "claude-code",
      clientIp: "203.0.113.1",
    });
    await t.withIdentity(OWNER).mutation(api.agentAuth.approveDeviceRequest, {
      userCode,
      parentType: "workspace",
      parentId: workspaceId,
      agentName: "Audited",
      role: "readonly",
      dailyActionLimit: 200,
    });
    await t.mutation(api.agentAuth.claimDeviceRequest, {
      deviceCode: "opd_audit",
      keyHash: "f".repeat(64),
      keyPrefix: "cua_audit12",
    });

    const events = await t.run(async (ctx) =>
      ctx.db.query("events").collect(),
    );
    const authorized = events.find((e) => e.type === "agent.authorized");
    const issued = events.find((e) => e.type === "agent.key_issued");

    // Two events, not one: a human said yes at one moment and a key came
    // into existence at another, and an approval never collected is worth
    // being able to see.
    expect(authorized).toBeDefined();
    expect(issued).toBeDefined();

    const payload = authorized!.payload as Record<string, unknown>;
    expect(payload.client).toBe("claude-code");
    expect(payload.role).toBe("readonly");
    expect(payload.dailyActionLimit).toBe(200);
    expect(payload.grant).toBe("device_code");
    expect(authorized!.actorId).toBe(OWNER.subject);

    // The key event carries the prefix, never anything that reconstructs
    // the key itself.
    const issuedPayload = issued!.payload as Record<string, unknown>;
    expect(issuedPayload.keyPrefix).toBe("cua_audit12");
    expect(issuedPayload.approvedBy).toBe(OWNER.subject);
    expect(JSON.stringify(issued)).not.toContain("f".repeat(64));
  });
});
