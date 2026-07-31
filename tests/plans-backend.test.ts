import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { sha256Hex } from "../convex/_agentAuth";
import { planView } from "../src/lib/plan";

// The plan, end to end.
//
// Two properties carry this feature, and neither is visible from the pure lib:
//
//  1. **Shape is enforced on write.** Unlike a panel — a view somebody can
//     shrug at, repaired on read — a malformed plan misrepresents what a team
//     agreed. Evidence filed under a question rather than an option is
//     evidence for nothing.
//  2. **A machine cannot close a question a person reserved.** The same
//     consent shape as approval gates and panel proposals, and the one place
//     the actor changes the outcome rather than just the byline.
//
// Everything else — question state, ordering — is derived by `planView`, which
// both the screen and the agent's `read_plan` run, so it is tested once in
// `plan.test.ts` and exercised here against real rows.

const modules = import.meta.glob("../convex/**/*.*s");

const ALICE = { subject: "user_alice" };
const OUTSIDER = { subject: "user_outsider" };

async function seed() {
  const t = convexTest(schema, modules);
  const workspaceId = await t.run(async (ctx) => {
    for (const u of [ALICE, OUTSIDER]) {
      await ctx.db.insert("users", {
        clerkId: u.subject,
        email: `${u.subject}@example.com`,
        name: u.subject === ALICE.subject ? "Alice" : "Nemo",
      });
    }
    const id = await ctx.db.insert("workspaces", {
      name: "Acme",
      slug: "acme",
      ownerClerkId: ALICE.subject,
      createdAt: Date.now(),
    });
    await ctx.db.insert("memberships", {
      userClerkId: ALICE.subject,
      workspaceId: id,
      role: "owner",
      joinedAt: Date.now(),
    });
    return id;
  });
  const alice = t.withIdentity(ALICE);
  const spaceId = await alice.mutation(api.spaces.create, {
    name: "HQ",
    parentType: "workspace",
    parentId: workspaceId,
  });
  const projectId = await alice.mutation(api.projects.create, {
    spaceId,
    name: "Launch",
  });
  const key = "cua_test_plan_agent";
  await t.run(async (ctx) => {
    const id = await ctx.db.insert("agents", {
      name: "Ada",
      parentType: "workspace",
      parentId: workspaceId,
      createdByClerkId: ALICE.subject,
      createdAt: Date.now(),
      status: "active",
      role: "member",
      dailyActionLimit: 2000,
    });
    await ctx.db.insert("agentKeys", {
      agentId: id,
      keyHash: sha256Hex(key),
      keyPrefix: key.slice(0, 12),
      createdAt: Date.now(),
    });
  });
  return { t, alice, workspaceId, spaceId, projectId, key };
}

async function read(
  t: Awaited<ReturnType<typeof seed>>["t"],
  projectId: Id<"projects">,
) {
  const rows = await t
    .withIdentity(ALICE)
    .query(api.plans.forProject, { projectId });
  return planView(rows);
}

describe("the shape is enforced on write", () => {
  it("refuses evidence filed under a question", async () => {
    // Evidence that does not attach to an option argues for nothing, and once
    // stored there is no honest way to render it.
    const { alice, projectId } = await seed();
    const questionId = await alice.mutation(api.plans.ask, {
      projectId,
      body: "Do we migrate now or after launch?",
    });
    await expect(
      alice.mutation(api.plans.addEvidence, {
        optionId: questionId,
        body: "staging took 40 minutes",
        stance: "refutes",
      }),
    ).rejects.toThrow(/option/i);
  });

  it("refuses an option grafted onto another project's question", async () => {
    const { t, alice, spaceId, projectId } = await seed();
    const otherProject = await alice.mutation(api.projects.create, {
      spaceId,
      name: "Other",
    });
    const questionId = await alice.mutation(api.plans.ask, {
      projectId: otherProject,
      body: "Unrelated question",
    });
    await expect(
      alice.mutation(api.plans.addOption, { questionId, body: "sneak in" }),
    ).resolves.toBeTruthy();
    // The option landed on the other project's plan, not this one.
    expect((await read(t, projectId)).questions).toHaveLength(0);
  });

  it("refuses a decision naming an option from a different question", async () => {
    const { alice, projectId } = await seed();
    const q1 = await alice.mutation(api.plans.ask, { projectId, body: "First?" });
    const q2 = await alice.mutation(api.plans.ask, { projectId, body: "Second?" });
    const strayOption = await alice.mutation(api.plans.addOption, {
      questionId: q2,
      body: "answer to the other one",
    });
    await expect(
      alice.mutation(api.plans.decide, {
        questionId: q1,
        chosenOptionId: strayOption,
        body: "settling",
      }),
    ).rejects.toThrow(/not one of this question/i);
  });

  it("refuses an empty body", async () => {
    const { alice, projectId } = await seed();
    await expect(
      alice.mutation(api.plans.ask, { projectId, body: "   " }),
    ).rejects.toThrow();
  });

  it("refuses to hang anything off a retracted node", async () => {
    const { alice, projectId } = await seed();
    const questionId = await alice.mutation(api.plans.ask, {
      projectId,
      body: "Which database?",
    });
    await alice.mutation(api.plans.retract, { nodeId: questionId });
    await expect(
      alice.mutation(api.plans.addOption, { questionId, body: "Postgres" }),
    ).rejects.toThrow(/retracted/i);
  });
});

describe("a machine cannot close a question a person reserved", () => {
  it("lands an agent's decision unaccepted when a human is required", async () => {
    const { t, alice, projectId, key } = await seed();
    const questionId = await alice.mutation(api.plans.ask, {
      projectId,
      body: "Do we ship on Friday?",
      needsHuman: true,
    });
    const option = await alice.mutation(api.plans.addOption, {
      questionId,
      body: "Yes, ship it",
    });
    await alice.mutation(api.plans.addEvidence, {
      optionId: option,
      body: "everything is green",
      stance: "supports",
    });

    const result = await t.mutation(api.agentApi.planDecide, {
      apiKey: key,
      questionId,
      chosenOptionId: option,
      body: "All checks pass",
    });
    expect(result.accepted).toBe(false);

    const view = await read(t, projectId);
    expect(view.questions[0].state).toBe("awaiting");
  });

  it("lets an agent settle a question nobody reserved", async () => {
    const { t, alice, projectId, key } = await seed();
    const questionId = await alice.mutation(api.plans.ask, {
      projectId,
      body: "Which log level in staging?",
    });
    const option = await alice.mutation(api.plans.addOption, {
      questionId,
      body: "debug",
    });
    await alice.mutation(api.plans.addEvidence, {
      optionId: option,
      body: "we need the detail",
      stance: "supports",
    });
    const result = await t.mutation(api.agentApi.planDecide, {
      apiKey: key,
      questionId,
      chosenOptionId: option,
      body: "debug it is",
    });
    expect(result.accepted).toBe(true);
    expect((await read(t, projectId)).questions[0].state).toBe("decided");
  });

  it("settles it the moment a person agrees", async () => {
    const { t, alice, projectId, key } = await seed();
    const questionId = await alice.mutation(api.plans.ask, {
      projectId,
      body: "Do we ship on Friday?",
      needsHuman: true,
    });
    const option = await alice.mutation(api.plans.addOption, {
      questionId,
      body: "Yes",
    });
    await alice.mutation(api.plans.addEvidence, {
      optionId: option,
      body: "green",
      stance: "supports",
    });
    await t.mutation(api.agentApi.planDecide, {
      apiKey: key,
      questionId,
      chosenOptionId: option,
      body: "All checks pass",
    });

    const before = await read(t, projectId);
    const decisionId = before.questions[0].decision!.id as Id<"planNodes">;
    await alice.mutation(api.plans.acceptDecision, { decisionId });

    const after = await read(t, projectId);
    expect(after.questions[0].state).toBe("decided");
    expect(after.questions[0].decision?.acceptedByName).toBe("Alice");
  });

  it("lets a person settle their own reserved question directly", async () => {
    const { t, alice, projectId } = await seed();
    const questionId = await alice.mutation(api.plans.ask, {
      projectId,
      body: "Do we ship on Friday?",
      needsHuman: true,
    });
    const option = await alice.mutation(api.plans.addOption, {
      questionId,
      body: "Yes",
    });
    const result = await alice.mutation(api.plans.decide, {
      questionId,
      chosenOptionId: option,
      body: "Shipping",
    });
    expect(result.accepted).toBe(true);
    expect((await read(t, projectId)).questions[0].state).toBe("decided");
  });

  it("refuses to accept the same decision twice", async () => {
    const { t, alice, projectId, key } = await seed();
    const questionId = await alice.mutation(api.plans.ask, {
      projectId,
      body: "Ship?",
      needsHuman: true,
    });
    const option = await alice.mutation(api.plans.addOption, {
      questionId,
      body: "Yes",
    });
    await t.mutation(api.agentApi.planDecide, {
      apiKey: key,
      questionId,
      chosenOptionId: option,
      body: "go",
    });
    const view = await read(t, projectId);
    const decisionId = view.questions[0].decision!.id as Id<"planNodes">;
    await alice.mutation(api.plans.acceptDecision, { decisionId });
    await expect(
      alice.mutation(api.plans.acceptDecision, { decisionId }),
    ).rejects.toThrow(/already/i);
  });
});

describe("retraction is how a question reopens", () => {
  it("drops a settled question back to its options", async () => {
    // No separate reopen verb, and the record of having once decided the other
    // way survives — the part a transcript gets right and a status field does
    // not.
    const { t, alice, projectId } = await seed();
    const questionId = await alice.mutation(api.plans.ask, {
      projectId,
      body: "Which queue?",
    });
    const option = await alice.mutation(api.plans.addOption, {
      questionId,
      body: "SQS",
    });
    await alice.mutation(api.plans.addEvidence, {
      optionId: option,
      body: "already in the stack",
      stance: "supports",
    });
    await alice.mutation(api.plans.decide, {
      questionId,
      chosenOptionId: option,
      body: "SQS then",
    });
    expect((await read(t, projectId)).questions[0].state).toBe("decided");

    const decided = await read(t, projectId);
    await alice.mutation(api.plans.retract, {
      nodeId: decided.questions[0].decision!.id as Id<"planNodes">,
    });

    const reopened = await read(t, projectId);
    expect(reopened.questions[0].state).toBe("ready");
    // The decision row is still there, just out of the derivation.
    const raw = await t
      .withIdentity(ALICE)
      .query(api.plans.forProject, { projectId });
    expect(raw.some((n) => n.kind === "decision" && n.retractedAt !== null)).toBe(
      true,
    );
  });

  it("puts a retracted node back", async () => {
    const { t, alice, projectId } = await seed();
    const questionId = await alice.mutation(api.plans.ask, {
      projectId,
      body: "Which queue?",
    });
    await alice.mutation(api.plans.retract, { nodeId: questionId });
    expect((await read(t, projectId)).questions).toHaveLength(0);
    await alice.mutation(api.plans.unretract, { nodeId: questionId });
    expect((await read(t, projectId)).questions).toHaveLength(1);
  });

  it("stops an agent retracting a person's reasoning", async () => {
    // A plan where your conclusions can be quietly removed by a machine is
    // not a shared artifact.
    const { t, alice, projectId, key } = await seed();
    const questionId = await alice.mutation(api.plans.ask, {
      projectId,
      body: "Which queue?",
    });
    await expect(
      t.mutation(api.agentApi.planRetract, { apiKey: key, nodeId: questionId }),
    ).rejects.toThrow(/only retract what you wrote/i);
  });

  it("lets an agent retract its own", async () => {
    const { t, alice, projectId, key } = await seed();
    const questionId = await alice.mutation(api.plans.ask, {
      projectId,
      body: "Which queue?",
    });
    const { nodeId } = await t.mutation(api.agentApi.planOption, {
      apiKey: key,
      questionId,
      body: "Kafka",
    });
    await t.mutation(api.agentApi.planRetract, { apiKey: key, nodeId });
    expect((await read(t, projectId)).questions[0].options).toHaveLength(0);
  });
});

describe("access", () => {
  it("shows an outsider nothing", async () => {
    const { t, alice, projectId } = await seed();
    await alice.mutation(api.plans.ask, { projectId, body: "Internal thinking" });
    const rows = await t
      .withIdentity(OUTSIDER)
      .query(api.plans.forProject, { projectId });
    expect(rows).toEqual([]);
  });

  it("refuses an outsider writing into it", async () => {
    const { t, projectId } = await seed();
    await expect(
      t.withIdentity(OUTSIDER).mutation(api.plans.ask, {
        projectId,
        body: "hello",
      }),
    ).rejects.toThrow();
  });

  it("refuses an unknown agent key", async () => {
    const { t, projectId } = await seed();
    await expect(
      t.mutation(api.agentApi.planAsk, {
        apiKey: "cua_not_a_key",
        projectId,
        body: "hello",
      }),
    ).rejects.toThrow();
  });
});

describe("agents and people write the same rows", () => {
  it("builds one plan from both", async () => {
    // The house rule: agents and people run the same cores, so a question
    // raised by a machine and one raised by a person are the same kind of
    // thing on the screen.
    const { t, alice, projectId, key } = await seed();
    const questionId = await alice.mutation(api.plans.ask, {
      projectId,
      body: "Do we cache the roster?",
    });
    const { nodeId: agentOption } = await t.mutation(api.agentApi.planOption, {
      apiKey: key,
      questionId,
      body: "Cache it for five minutes",
    });
    await t.mutation(api.agentApi.planEvidence, {
      apiKey: key,
      optionId: agentOption as Id<"planNodes">,
      body: "the roster query is 400ms at p95",
      stance: "supports",
      ref: { kind: "task", id: "t123" },
    });
    await alice.mutation(api.plans.addOption, {
      questionId,
      body: "Leave it uncached",
    });

    const view = await read(t, projectId);
    const q = view.questions[0];
    expect(q.options).toHaveLength(2);
    // One option argued, one not — so the question is still being worked out.
    expect(q.state).toBe("weighing");
    const cached = q.options.find((o) => o.node.body.startsWith("Cache"))!;
    expect(cached.supports).toBe(1);
    expect(cached.evidence[0].authorType).toBe("agent");
    expect(cached.evidence[0].ref).toEqual({ kind: "task", id: "t123" });
  });

  it("logs a question and a decision to the activity feed, and nothing else", async () => {
    // Every option and every piece of evidence would be the transcript this
    // whole thing replaces.
    const { t, alice, projectId } = await seed();
    const questionId = await alice.mutation(api.plans.ask, {
      projectId,
      body: "Which queue?",
    });
    const option = await alice.mutation(api.plans.addOption, {
      questionId,
      body: "SQS",
    });
    await alice.mutation(api.plans.addEvidence, {
      optionId: option,
      body: "already in the stack",
      stance: "supports",
    });
    await alice.mutation(api.plans.decide, {
      questionId,
      chosenOptionId: option,
      body: "SQS",
    });

    const types = await t.run(async (ctx) => {
      const events = await ctx.db.query("events").collect();
      return events.map((e) => e.type).filter((tp) => tp.startsWith("question."));
    });
    expect(types).toEqual(["question.opened", "question.decided"]);
  });
});
