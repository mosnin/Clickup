import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";

// Regression coverage for the W2 fix (finding 3): goals.setProgress must
// not only flip open -> complete, it must also flip a previously-complete
// goal back to open when its progress drops below target — otherwise the
// checkbox/status could contradict the number (e.g. "complete" at 40/100).

const modules = import.meta.glob("../convex/**/*.*s");

const OWNER = { subject: "user_owner", email: "owner@acme.com" };

async function createGoal(
  t: ReturnType<typeof convexTest>,
  targetValue: number,
) {
  await t.run(async (ctx) => {
    // .filter instead of .withIndex: the schemaless test ctx doesn't carry
    // index typings, and a full scan is fine for a seed helper.
    const existing = await ctx.db
      .query("users")
      .filter((q) => q.eq(q.field("clerkId"), OWNER.subject))
      .unique();
    if (!existing) {
      await ctx.db.insert("users", {
        clerkId: OWNER.subject,
        email: OWNER.email,
      });
    }
  });
  const owner = t.withIdentity(OWNER);
  const goalId = await owner.mutation(api.goals.create, {
    parentType: "user",
    parentId: OWNER.subject,
    title: "Ship it",
    targetType: "number",
    targetValue,
  });
  return { owner, goalId };
}

describe("goals.setProgress", () => {
  it("marks a goal complete once currentValue reaches target", async () => {
    const t = convexTest(schema, modules);
    const { owner, goalId } = await createGoal(t, 100);

    await owner.mutation(api.goals.setProgress, { goalId, currentValue: 100 });
    const goal = await owner.query(api.goals.get, { goalId });
    expect(goal?.status).toBe("complete");
    expect(goal?.completedAt).toBeDefined();
  });

  it("reopens a complete goal when progress drops back below target", async () => {
    const t = convexTest(schema, modules);
    const { owner, goalId } = await createGoal(t, 100);

    await owner.mutation(api.goals.setProgress, { goalId, currentValue: 100 });
    let goal = await owner.query(api.goals.get, { goalId });
    expect(goal?.status).toBe("complete");

    // Progress corrected downward (e.g. a rollup adjustment) — status must
    // not still say "complete" while the number says 40/100.
    await owner.mutation(api.goals.setProgress, { goalId, currentValue: 40 });
    goal = await owner.query(api.goals.get, { goalId });
    expect(goal?.status).toBe("open");
    expect(goal?.currentValue).toBe(40);
    expect(goal?.completedAt).toBeUndefined();
  });

  it("does not reopen an abandoned goal just because progress moves", async () => {
    const t = convexTest(schema, modules);
    const { owner, goalId } = await createGoal(t, 100);

    await owner.mutation(api.goals.update, { goalId, status: "abandoned" });
    await owner.mutation(api.goals.setProgress, { goalId, currentValue: 10 });
    const goal = await owner.query(api.goals.get, { goalId });
    expect(goal?.status).toBe("abandoned");
  });
});
