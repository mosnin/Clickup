import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";

// Agent templates spin up a pre-governed agent in one call. These prove
// the preset governance is applied and scope access is enforced.

const modules = import.meta.glob("../convex/**/*.*s");
const ALICE = { subject: "user_alice" };
const MALLORY = { subject: "user_mallory" };

describe("agent templates", () => {
  it("applies preset role + budget in the caller's personal scope", async () => {
    const t = convexTest(schema, modules);
    const agentId = await t
      .withIdentity(ALICE)
      .mutation(api.agentTemplates.createFromTemplate, {
        slug: "watchtower",
        parentType: "user",
        parentId: ALICE.subject,
      });
    const agent = await t.run((ctx) => ctx.db.get(agentId));
    expect(agent?.role).toBe("readonly");
    expect(agent?.dailyActionLimit).toBe(2000);
    // Templates no longer author an emoji onto the created agent — the
    // product renders no emoji, ever (the schema field stays for data
    // compatibility with any pre-existing rows).
    expect(agent?.emoji).toBeUndefined();
  });

  it("refuses a personal scope that isn't the caller's", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t
        .withIdentity(MALLORY)
        .mutation(api.agentTemplates.createFromTemplate, {
          slug: "triage",
          parentType: "user",
          parentId: ALICE.subject,
        }),
    ).rejects.toThrow(/forbidden/i);
  });

  it("refuses a workspace-only template targeting a personal space", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t
        .withIdentity(ALICE)
        .mutation(api.agentTemplates.createFromTemplate, {
          slug: "sprint-planner",
          parentType: "user",
          parentId: ALICE.subject,
        }),
    ).rejects.toThrow(/workspace/i);
  });

  it("rejects an unknown template", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t
        .withIdentity(ALICE)
        .mutation(api.agentTemplates.createFromTemplate, {
          slug: "does-not-exist",
          parentType: "user",
          parentId: ALICE.subject,
        }),
    ).rejects.toThrow(/unknown template/i);
  });
});
