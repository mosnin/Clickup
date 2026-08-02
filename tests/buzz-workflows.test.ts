import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { anyApi, defineSchema } from "convex/server";
import baseSchema from "../convex/schema";
import { publicKeyFromSecret } from "../convex/buzz/_nostr";
import { RELAY_SEED_ENV } from "../convex/buzz/relay";
import { publishCore } from "../convex/buzz/log";
import {
  APPROVAL_TAG,
  KIND_WORKFLOW_APPROVAL_REQUESTED,
  KIND_WORKFLOW_COMPLETED,
  KIND_WORKFLOW_TRIGGERED,
  WORKFLOW_TAG,
  approverSpecAllows,
  buzzWorkflowTables,
  flattenBody,
  isWorkflowExecutionKind,
  shouldFire,
  triggerContextFromEvent,
  triggerMatchesEvent,
} from "../convex/buzz/workflows";
import { parseWorkflowYaml, type WorkflowDef } from "../src/lib/buzz/workflow-schema";

// The engine, driven end to end.
//
// What this file is trying to prove, in the order the spec puts it:
//
//   - **All four doors fire, and only when they should.** An ingested event, the
//     cron tick, a manual trigger and the webhook endpoint each create a run;
//     the wrong kind, a false filter, a spent claim, a wrong secret and a
//     disabled workflow each create nothing.
//   - **Authority is re-read at every fire (§1.8).** A workflow written by an
//     admin stops firing the moment its owner is demoted — the definition is not
//     a stored grant — and nothing a workflow does reaches past what its owner
//     could do by hand.
//   - **The gate really blocks.** A run that reaches `request_approval` stops,
//     and the step *after* it has demonstrably not happened until a human acts.
//     A test that only checked the run's status would pass against an engine
//     that ran every step and then set a flag.
//   - **The tenancy fence holds.** The same workflow id in two workspaces is two
//     workflows, and neither is reachable from the other.
//
// `anyApi` rather than the generated `api`, for the reason every buzz suite
// states: `convex/_generated/api.d.ts` is a hand-rolled stub that predates
// `convex/buzz/*` and only `npx convex dev` may rewrite it. The four workflow
// tables are declared in `convex/buzz/workflows.ts` and are not yet spread into
// `convex/schema.ts` (that file is edited by every concurrent Chat phase, so the
// fold is one line the integrator applies) — hence the schema built below.

const modules = import.meta.glob("../convex/**/*.*s");
const channels = anyApi.buzz.channels;
const messages = anyApi.buzz.messages;
const workflows = anyApi.buzz.workflows;

const schema = defineSchema({ ...baseSchema.tables, ...buzzWorkflowTables });

const ALICE = { subject: "user_alice" }; // workspace + channel owner
const BOB = { subject: "user_bob" }; // promoted to channel admin, then demoted
const CAROL = { subject: "user_carol" }; // ordinary member
const OUTSIDER = { subject: "user_outsider" }; // in no workspace at all

const KEYS: Record<string, string> = {
  [ALICE.subject]: "01".repeat(32),
  [BOB.subject]: "02".repeat(32),
  [CAROL.subject]: "03".repeat(32),
  [OUTSIDER.subject]: "04".repeat(32),
};

type Ctx = Parameters<Parameters<ReturnType<typeof convexTest>["run"]>[0]>[0];
type Scope = { scopeType: "user" | "workspace"; scopeId: string };
type Harness = ReturnType<typeof convexTest>;
type Run = {
  id: string;
  status: string;
  currentStep: number;
  executionTrace: { stepId: string; status: string; output: Record<string, unknown> }[];
  errorMessage: string | null;
};

let previousSeed: string | undefined;

beforeAll(() => {
  previousSeed = process.env[RELAY_SEED_ENV];
  process.env[RELAY_SEED_ENV] = "test-relay-seed-0123456789abcdef0123456789abcdef";
});

afterAll(() => {
  if (previousSeed === undefined) delete process.env[RELAY_SEED_ENV];
  else process.env[RELAY_SEED_ENV] = previousSeed;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function pubkeyOf(person: { subject: string }): string {
  return publicKeyFromSecret(KEYS[person.subject]);
}

async function seed() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx: Ctx) => {
    for (const person of [ALICE, BOB, CAROL, OUTSIDER]) {
      await ctx.db.insert("users", {
        clerkId: person.subject,
        email: `${person.subject}@example.test`,
        name: person.subject,
      });
      await ctx.db.insert("buzzKeys", {
        principalType: "user",
        principalId: person.subject,
        pubkey: pubkeyOf(person),
        secretKey: KEYS[person.subject],
        createdAt: Date.now(),
      });
    }
    const workspaceId = await ctx.db.insert("workspaces", {
      name: "Acme",
      slug: "acme",
      ownerClerkId: ALICE.subject,
      createdAt: Date.now(),
    });
    const otherWorkspaceId = await ctx.db.insert("workspaces", {
      name: "Beta",
      slug: "beta",
      ownerClerkId: ALICE.subject,
      createdAt: Date.now(),
    });
    for (const [subject, role] of [
      [ALICE.subject, "owner"],
      [BOB.subject, "member"],
      [CAROL.subject, "member"],
    ] as const) {
      await ctx.db.insert("memberships", {
        userClerkId: subject,
        workspaceId,
        role,
        joinedAt: Date.now(),
      });
    }
    await ctx.db.insert("memberships", {
      userClerkId: ALICE.subject,
      workspaceId: otherWorkspaceId,
      role: "owner",
      joinedAt: Date.now(),
    });
    return { workspaceId, otherWorkspaceId };
  });

  const scope: Scope = { scopeType: "workspace", scopeId: ids.workspaceId };
  const otherScope: Scope = { scopeType: "workspace", scopeId: ids.otherWorkspaceId };
  const channelId = await createChannel(t, scope, "ops");
  await t.withIdentity(ALICE).mutation(channels.addMembers, {
    ...scope,
    channelId,
    members: [
      { actorId: BOB.subject, actorType: "user" },
      { actorId: CAROL.subject, actorType: "user" },
    ],
    role: "member",
  });
  return { t, scope, otherScope, channelId };
}

async function createChannel(t: Harness, scope: Scope, name: string, as = ALICE) {
  const result = (await t
    .withIdentity(as)
    .mutation(channels.create, { ...scope, name })) as { channelId: string };
  return result.channelId;
}

async function save(
  t: Harness,
  scope: Scope,
  channelId: string,
  yaml: string,
  as = ALICE,
  workflowId?: string,
): Promise<{ workflowId: string; webhookSecret: string | null }> {
  return (await t
    .withIdentity(as)
    .mutation(workflows.save, {
      ...scope,
      channelId,
      yaml,
      ...(workflowId === undefined ? {} : { workflowId }),
    })) as { workflowId: string; webhookSecret: string | null };
}

async function post(t: Harness, scope: Scope, channelId: string, body: string, as = BOB) {
  return (await t
    .withIdentity(as)
    .mutation(messages.post, { ...scope, channelId, body })) as { eventId: string };
}

type LogEvent = {
  id: string;
  pubkey: string;
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
};

/**
 * The room's events, read through the log's own public read path.
 *
 * Deliberately not a raw `ctx.db` query: the assertions below are about what a
 * member of the room can actually see, and `buzz.log.read` is the function that
 * answers that — gates, channel fence and all.
 */
async function eventsIn(
  t: Harness,
  scope: Scope,
  channelId: string,
  kinds?: number[],
): Promise<LogEvent[]> {
  return (await t.withIdentity(ALICE).query(anyApi.buzz.log.read, {
    ...scope,
    filters: [
      {
        ...(kinds === undefined ? {} : { kinds }),
        tags: [{ name: "h", values: [channelId] }],
      },
    ],
  })) as LogEvent[];
}

/**
 * The post-store hook.
 *
 * Now docked in `messages.postMessageCore`, so posting a message already
 * dispatches. This is kept for the cases that need to dispatch an event the
 * message path did not write — and calling it after a `post` would fire the
 * workflow a second time, which is exactly what three tests caught the day the
 * door was docked.
 */
async function dispatch(t: Harness, scope: Scope, eventId: string) {
  return (await t.mutation(workflows.dispatchEvent, { ...scope, eventId })) as {
    fired: string[];
  };
}

async function runsOf(t: Harness, scope: Scope, workflowId: string): Promise<Run[]> {
  return (await t
    .withIdentity(ALICE)
    .query(workflows.runsFor, { ...scope, workflowId })) as Run[];
}

async function messagesIn(t: Harness, scope: Scope, channelId: string): Promise<string[]> {
  const page = (await t
    .withIdentity(ALICE)
    .query(messages.list, { ...scope, channelId })) as { events: { kind: number; content: string }[] };
  return page.events.filter((e) => e.kind === 9).map((e) => e.content);
}

const SEND_ON_P1 = `name: Incident Triage
trigger:
  on: message_posted
  filter: "str_contains(trigger_text, 'P1')"
steps:
  - id: notify
    action: send_message
    text: "P1 incident detected: {{trigger.text | truncate(12)}}"
`;

// ---------------------------------------------------------------------------

describe("pure predicates the engine leans on", () => {
  it("excludes the whole 46001..46012 band from triggering", () => {
    expect(isWorkflowExecutionKind(46001)).toBe(true);
    expect(isWorkflowExecutionKind(46012)).toBe(true);
    expect(isWorkflowExecutionKind(46000)).toBe(false);
    expect(isWorkflowExecutionKind(46020)).toBe(false);
  });

  it("maps trigger types to kinds strictly", () => {
    const def = (yaml: string): WorkflowDef => {
      const parsed = parseWorkflowYaml(yaml);
      if (!parsed.ok) throw new Error(parsed.error.message);
      return parsed.value;
    };
    const message = def(SEND_ON_P1);
    expect(triggerMatchesEvent(message, 9)).toBe(true);
    // Not 40002 (v2 messages), not 45001 (forum posts) — §1.10 says only kind 9.
    expect(triggerMatchesEvent(message, 40002)).toBe(false);
    expect(triggerMatchesEvent(message, 45001)).toBe(false);
    const diff = def(
      "name: d\ntrigger:\n  on: diff_posted\nsteps:\n  - id: a\n    action: delay\n    duration: 1s\n",
    );
    expect(triggerMatchesEvent(diff, 40008)).toBe(true);
    expect(triggerMatchesEvent(diff, 9)).toBe(false);
    const scheduled = def(
      "name: s\ntrigger:\n  on: schedule\n  interval: 300\nsteps:\n  - id: a\n    action: delay\n    duration: 1s\n",
    );
    // A schedule never matches an ingested event, whatever its kind.
    for (const kind of [9, 7, 40008]) expect(triggerMatchesEvent(scheduled, kind)).toBe(false);
  });

  it("reads a reaction's target from the last 64-hex e tag", () => {
    const root = "a".repeat(64);
    const target = "b".repeat(64);
    const context = triggerContextFromEvent(
      {
        id: "c".repeat(64),
        pubkey: "d".repeat(64),
        kind: 7,
        created_at: 1,
        tags: [
          ["e", root],
          ["e", target],
        ],
        content: "🚨",
      },
      "chan",
    );
    expect(context.messageId).toBe(target);
    expect(context.emoji).toBe("🚨");
  });

  it("prefers an actor tag over the signing pubkey for trigger.author", () => {
    const context = triggerContextFromEvent(
      {
        id: "c".repeat(64),
        pubkey: "d".repeat(64),
        kind: 9,
        created_at: 1,
        tags: [["actor", "e".repeat(64)]],
        content: "hi",
      },
      "chan",
    );
    expect(context.author).toBe("e".repeat(64));
  });

  it("stringifies a webhook body and ignores anything that is not an object", () => {
    expect(flattenBody({ a: "x", b: 2, c: true, d: null, e: { f: 1 } })).toEqual({
      a: "x",
      b: "2",
      c: "true",
      d: "",
      e: '{"f":1}',
    });
    expect(flattenBody([1, 2])).toEqual({});
    expect(flattenBody("nope")).toEqual({});
  });

  it("accepts only the approver specs §1.11 enumerates", () => {
    const key = "a".repeat(64);
    expect(approverSpecAllows("", key)).toBe(true);
    expect(approverSpecAllows("any", key)).toBe(true);
    expect(approverSpecAllows(key.toUpperCase(), key)).toBe(true);
    expect(approverSpecAllows("b".repeat(64), key)).toBe(false);
    // Fail closed on a role string — accepting it as "anyone" is a gate that
    // silently opens.
    expect(approverSpecAllows("@release-manager", key)).toBe(false);
  });
});

describe("saving (§1.2, §1.7, §1.8)", () => {
  it("stores a workflow and reads it back without its secret", async () => {
    const { t, scope, channelId } = await seed();
    const saved = await save(t, scope, channelId, SEND_ON_P1);
    expect(saved.webhookSecret).toBeNull();

    const view = (await t
      .withIdentity(ALICE)
      .query(workflows.get, { ...scope, workflowId: saved.workflowId })) as {
      name: string;
      channelId: string;
      definition: Record<string, unknown>;
      enabled: boolean;
    } | null;
    expect(view?.name).toBe("Incident Triage");
    expect(view?.channelId).toBe(channelId);
    expect(view?.enabled).toBe(true);
    expect(Object.keys(view?.definition ?? {})).not.toContain("_webhook_secret");

    const list = (await t
      .withIdentity(CAROL)
      .query(workflows.listForChannel, { ...scope, channelId })) as { id: string }[];
    expect(list.map((w) => w.id)).toEqual([saved.workflowId]);
  });

  it("hands the webhook secret over exactly once, and never on a read", async () => {
    const { t, scope, channelId } = await seed();
    const yaml =
      "name: hook\ntrigger:\n  on: webhook\nsteps:\n  - id: a\n    action: send_message\n    text: fired\n";
    const first = await save(t, scope, channelId, yaml, ALICE, "wf_hook");
    expect(first.webhookSecret).toMatch(/^[0-9a-f]{64}$/);

    const again = await save(t, scope, channelId, yaml, ALICE, "wf_hook");
    expect(again.webhookSecret).toBeNull();

    const view = (await t
      .withIdentity(ALICE)
      .query(workflows.get, { ...scope, workflowId: "wf_hook" })) as {
      definition: Record<string, unknown>;
    };
    expect(view.definition._webhook_secret).toBeUndefined();

    const rotated = (await t
      .withIdentity(ALICE)
      .mutation(workflows.rotateWebhookSecret, { ...scope, workflowId: "wf_hook" })) as {
      webhookSecret: string;
    };
    expect(rotated.webhookSecret).not.toBe(first.webhookSecret);
  });

  it("surfaces a validator rejection verbatim", async () => {
    const { t, scope, channelId } = await seed();
    await expect(
      save(
        t,
        scope,
        channelId,
        "name: x\ntrigger:\n  on: webhook\nsteps:\n  - id: step1\n    action: delay\n    duration: 1s\n  - id: step1\n    action: delay\n    duration: 1s\n",
      ),
    ).rejects.toThrow(/invalid: workflow YAML parse error: duplicate step id: step1/);
  });

  it("pins ownership and the channel across updates", async () => {
    const { t, scope, channelId } = await seed();
    await save(t, scope, channelId, SEND_ON_P1, ALICE, "wf_pin");
    await expect(save(t, scope, channelId, SEND_ON_P1, CAROL, "wf_pin")).rejects.toThrow(
      /belongs to somebody else/,
    );
    const other = await createChannel(t, scope, "random");
    await expect(save(t, scope, other, SEND_ON_P1, ALICE, "wf_pin")).rejects.toThrow(
      /cannot be moved/,
    );
  });

  it("lets only an owner or admin author a call_webhook workflow (SEC-006)", async () => {
    const { t, scope, channelId } = await seed();
    const yaml =
      "name: exfil\ntrigger:\n  on: webhook\nsteps:\n  - id: a\n    action: call_webhook\n    url: 'https://example.com/hook'\n";
    await expect(save(t, scope, channelId, yaml, CAROL, "wf_x")).rejects.toThrow(
      /channel owner or admin/,
    );
    await t
      .withIdentity(ALICE)
      .mutation(channels.setRole, { ...scope, channelId, actorId: BOB.subject, role: "admin" });
    const saved = await save(t, scope, channelId, yaml, BOB, "wf_x");
    expect(saved.workflowId).toBe("wf_x");
  });
});

describe("door 1 — an ingested event (§1.10)", () => {
  it("fires on a matching message and posts the templated reply", async () => {
    const { t, scope, channelId } = await seed();
    const { workflowId } = await save(t, scope, channelId, SEND_ON_P1);

    const quiet = await post(t, scope, channelId, "all good here");
    expect((await dispatch(t, scope, quiet.eventId)).fired).toEqual([]);

    // No explicit dispatch: posting a message IS the door now. Re-dispatching
    // here would be a second delivery of one event, which the at-most-once
    // guard refuses — the assertion below is the fire, not the call.
    await post(t, scope, channelId, "P1 outage in production");

    const runs = await runsOf(t, scope, workflowId);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("completed");
    expect(runs[0].executionTrace.map((e) => [e.stepId, e.status])).toEqual([
      ["notify", "completed"],
    ]);
    expect(await messagesIn(t, scope, channelId)).toContain("P1 incident detected: P1 outage in");
  });

  it("does not answer its own output — the loop stops at one hop", async () => {
    const { t, scope, channelId } = await seed();
    const { workflowId } = await save(t, scope, channelId, SEND_ON_P1);
    await post(t, scope, channelId, "P1 again");

    // Find the message the workflow posted and feed it back through the door.
    const posted = (await eventsIn(t, scope, channelId, [9])).filter((e) =>
      e.tags.some((tag) => tag[0] === WORKFLOW_TAG),
    );
    expect(posted).toHaveLength(1);
    expect((await dispatch(t, scope, posted[0].id)).fired).toEqual([]);
    expect(await runsOf(t, scope, workflowId)).toHaveLength(1);
  });

  it("fires on a reaction only when the emoji matches", async () => {
    const { t, scope, channelId } = await seed();
    const { workflowId } = await save(
      t,
      scope,
      channelId,
      "name: siren\ntrigger:\n  on: reaction_added\n  emoji: \"🚨\"\nsteps:\n  - id: echo\n    action: send_message\n    text: 'someone rang the alarm'\n",
    );
    const target = await post(t, scope, channelId, "deploy done");

    const shrug = (await t
      .withIdentity(CAROL)
      .mutation(messages.react, {
        ...scope,
        channelId,
        targetId: target.eventId,
        emoji: "👍",
      })) as { eventId: string };
    expect((await dispatch(t, scope, shrug.eventId)).fired).toEqual([]);

    const siren = (await t
      .withIdentity(CAROL)
      .mutation(messages.react, {
        ...scope,
        channelId,
        targetId: target.eventId,
        emoji: "🚨",
      })) as { eventId: string };
    expect((await dispatch(t, scope, siren.eventId)).fired).toHaveLength(1);
    expect((await runsOf(t, scope, workflowId))[0].status).toBe("completed");
  });

  it("fires on a diff (kind 40008) and not on an ordinary message", async () => {
    const { t, scope, channelId } = await seed();
    const { workflowId } = await save(
      t,
      scope,
      channelId,
      "name: ci\ntrigger:\n  on: diff_posted\nsteps:\n  - id: ack\n    action: send_message\n    text: 'diff seen'\n",
    );
    const ordinary = await post(t, scope, channelId, "just talking");
    expect((await dispatch(t, scope, ordinary.eventId)).fired).toEqual([]);

    // A diff is not something `postMessageCore` will say (`SAYABLE_KINDS`), so
    // it is published straight through the log — which is also the honest test
    // of the door: it takes whatever landed, not only what a composer sent.
    const diffId = await t.run(async (ctx: Ctx) => {
      const outcome = await publishCore(ctx, {
        actor: { type: "user", id: BOB.subject, name: "bob" },
        scope,
        kind: 40008,
        tags: [["h", channelId]],
        content: "--- a\n+++ b\n",
      });
      return outcome.event.id;
    });
    expect((await dispatch(t, scope, diffId)).fired).toHaveLength(1);
    expect((await runsOf(t, scope, workflowId))[0].status).toBe("completed");
  });

  it("skips the workflow when its filter errors — fail closed", async () => {
    const { t, scope, channelId } = await seed();
    const { workflowId } = await save(
      t,
      scope,
      channelId,
      "name: broken\ntrigger:\n  on: message_posted\n  filter: 'no_such_variable'\nsteps:\n  - id: a\n    action: send_message\n    text: nope\n",
    );
    const said = await post(t, scope, channelId, "anything");
    expect((await dispatch(t, scope, said.eventId)).fired).toEqual([]);
    expect(await runsOf(t, scope, workflowId)).toEqual([]);
  });

  it("does not fire a disabled workflow", async () => {
    const { t, scope, channelId } = await seed();
    const { workflowId } = await save(
      t,
      scope,
      channelId,
      `${SEND_ON_P1}enabled: false\n`,
    );
    const said = await post(t, scope, channelId, "P1 here");
    expect((await dispatch(t, scope, said.eventId)).fired).toEqual([]);
    expect(await runsOf(t, scope, workflowId)).toEqual([]);
  });

  it("emits the 46001/46005 lifecycle band into the room", async () => {
    const { t, scope, channelId } = await seed();
    await save(t, scope, channelId, SEND_ON_P1);
    const alarm = await post(t, scope, channelId, "P1 lifecycle");
    await dispatch(t, scope, alarm.eventId);

    const kinds = (await eventsIn(t, scope, channelId)).map((e) => e.kind);
    expect(kinds).toContain(KIND_WORKFLOW_TRIGGERED);
    expect(kinds).toContain(KIND_WORKFLOW_COMPLETED);
  });
});

describe("door 2 — the schedule (§1.10)", () => {
  const CRON = `name: Daily Standup
trigger:
  on: schedule
  cron: '0 9 * * 1-5'
steps:
  - id: prompt
    action: send_message
    text: Standup time
`;

  it("fires once per scheduled instant, and the claim stops the second tick", async () => {
    const { t, scope, channelId } = await seed();
    const { workflowId } = await save(t, scope, channelId, CRON);
    // A Monday, 09:00 UTC — plus four minutes of tick drift.
    const nowSecs = Date.UTC(2026, 7, 3, 9, 4, 0) / 1000;

    const first = (await t.mutation(workflows.tickScheduled, {
      ...scope,
      windowSecs: 900,
      nowSecs,
    })) as { fired: string[] };
    expect(first.fired).toHaveLength(1);

    const second = (await t.mutation(workflows.tickScheduled, {
      ...scope,
      windowSecs: 900,
      nowSecs: nowSecs + 60,
    })) as { fired: string[] };
    expect(second.fired).toEqual([]);
    expect(await runsOf(t, scope, workflowId)).toHaveLength(1);
    expect(await messagesIn(t, scope, channelId)).toContain("Standup time");
  });

  it("does not fire outside the cron window", async () => {
    const { t, scope, channelId } = await seed();
    await save(t, scope, channelId, CRON);
    const sunday = Date.UTC(2026, 7, 2, 9, 0, 0) / 1000;
    const result = (await t.mutation(workflows.tickScheduled, {
      ...scope,
      windowSecs: 900,
      nowSecs: sunday,
    })) as { fired: string[] };
    expect(result.fired).toEqual([]);
  });

  it("fires an interval once per epoch-aligned bucket", async () => {
    const { t, scope, channelId } = await seed();
    await save(
      t,
      scope,
      channelId,
      "name: every5\ntrigger:\n  on: schedule\n  interval: 300\nsteps:\n  - id: a\n    action: send_message\n    text: tick\n",
    );
    const base = 1_700_000_000 - (1_700_000_000 % 300);
    const one = (await t.mutation(workflows.tickScheduled, {
      ...scope,
      nowSecs: base + 10,
    })) as { fired: string[] };
    const two = (await t.mutation(workflows.tickScheduled, {
      ...scope,
      nowSecs: base + 200,
    })) as { fired: string[] };
    const three = (await t.mutation(workflows.tickScheduled, {
      ...scope,
      nowSecs: base + 310,
    })) as { fired: string[] };
    expect(one.fired).toHaveLength(1);
    expect(two.fired).toEqual([]);
    expect(three.fired).toHaveLength(1);
  });

  it("checks the owner's authority before burning the claim", async () => {
    const { t, scope, channelId } = await seed();
    await t
      .withIdentity(ALICE)
      .mutation(channels.setRole, { ...scope, channelId, actorId: BOB.subject, role: "admin" });
    // Owned by Bob, and elevated (call_webhook), so a demotion revokes it.
    await save(
      t,
      scope,
      channelId,
      "name: sched-hook\ntrigger:\n  on: schedule\n  interval: 300\nsteps:\n  - id: a\n    action: call_webhook\n    url: 'https://example.com/hook'\n",
      BOB,
      "wf_sched",
    );
    await t
      .withIdentity(ALICE)
      .mutation(channels.setRole, { ...scope, channelId, actorId: BOB.subject, role: "member" });

    const base = 1_700_000_000 - (1_700_000_000 % 300);
    const result = (await t.mutation(workflows.tickScheduled, {
      ...scope,
      nowSecs: base + 10,
    })) as { fired: string[] };
    expect(result.fired).toEqual([]);
    // And the slot is still free, so a re-promotion fires it rather than finding
    // the claim already spent.
    await t
      .withIdentity(ALICE)
      .mutation(channels.setRole, { ...scope, channelId, actorId: BOB.subject, role: "admin" });
    const after = (await t.mutation(workflows.tickScheduled, {
      ...scope,
      nowSecs: base + 20,
    })) as { fired: string[] };
    expect(after.fired).toHaveLength(1);
  });
});

describe("door 3 — the manual trigger (§1.10)", () => {
  const MANUAL = `name: greet
trigger:
  on: webhook
steps:
  - id: hello
    action: send_message
    text: "hello {{trigger.who}}"
`;

  it("runs on the owner's say-so and binds the inputs", async () => {
    const { t, scope, channelId } = await seed();
    const { workflowId } = await save(t, scope, channelId, MANUAL);
    const result = (await t
      .withIdentity(ALICE)
      .mutation(workflows.trigger, {
        ...scope,
        workflowId,
        inputs: { who: "ada" },
      })) as { runId: string };
    expect(result.runId).toBeTruthy();
    expect(await messagesIn(t, scope, channelId)).toContain("hello ada");
  });

  it("refuses everyone but the owner", async () => {
    const { t, scope, channelId } = await seed();
    const { workflowId } = await save(t, scope, channelId, MANUAL);
    await expect(
      t.withIdentity(CAROL).mutation(workflows.trigger, { ...scope, workflowId }),
    ).rejects.toThrow(/belongs to somebody else/);
  });

  it("refuses when the workflow is not active", async () => {
    const { t, scope, channelId } = await seed();
    const { workflowId } = await save(t, scope, channelId, MANUAL);
    await t
      .withIdentity(ALICE)
      .mutation(workflows.setStatus, { ...scope, workflowId, status: "disabled" });
    await expect(
      t.withIdentity(ALICE).mutation(workflows.trigger, { ...scope, workflowId }),
    ).rejects.toThrow(/not active/);
  });
});

describe("door 4 — the webhook (§1.10, §1.8)", () => {
  const HOOK = `name: hook
trigger:
  on: webhook
steps:
  - id: say
    action: send_message
    text: "webhook says {{trigger.status}}"
`;

  it("accepts the right secret and refuses everything else identically", async () => {
    const { t, scope, channelId } = await seed();
    const saved = await save(t, scope, channelId, HOOK, ALICE, "wf_door");
    const secret = saved.webhookSecret as string;

    const wrong = await t.mutation(workflows.fireWebhook, {
      ...scope,
      workflowId: "wf_door",
      secret: "0".repeat(64),
      body: {},
    });
    expect(wrong).toEqual({ status: "not_found" });

    const missing = await t.mutation(workflows.fireWebhook, {
      ...scope,
      workflowId: "wf_nope",
      secret,
      body: {},
    });
    // The same answer, so a caller cannot tell a wrong secret from a workflow
    // that does not exist.
    expect(missing).toEqual({ status: "not_found" });

    const ok = (await t.mutation(workflows.fireWebhook, {
      ...scope,
      workflowId: "wf_door",
      secret,
      body: { status: "green" },
    })) as { status: string; runId: string };
    expect(ok.status).toBe("accepted");
    expect(await messagesIn(t, scope, channelId)).toContain("webhook says green");
  });

  it("refuses a workflow whose trigger is not a webhook, and a disabled one", async () => {
    const { t, scope, channelId } = await seed();
    const saved = await save(t, scope, channelId, HOOK, ALICE, "wf_off");
    const secret = saved.webhookSecret as string;
    await t
      .withIdentity(ALICE)
      .mutation(workflows.setStatus, { ...scope, workflowId: "wf_off", status: "disabled" });
    expect(
      await t.mutation(workflows.fireWebhook, {
        ...scope,
        workflowId: "wf_off",
        secret,
        body: {},
      }),
    ).toEqual({ status: "not_found" });

    await save(t, scope, channelId, SEND_ON_P1, ALICE, "wf_msg");
    expect(
      await t.mutation(workflows.fireWebhook, {
        ...scope,
        workflowId: "wf_msg",
        secret,
        body: {},
      }),
    ).toEqual({ status: "not_found" });
  });
});

describe("the actions (§1.3)", () => {
  it("adds a reaction to the triggering message", async () => {
    const { t, scope, channelId } = await seed();
    await save(
      t,
      scope,
      channelId,
      "name: ack\ntrigger:\n  on: message_posted\n  filter: \"str_contains(trigger_text, 'ship')\"\nsteps:\n  - id: ack\n    action: add_reaction\n    emoji: '👀'\n",
    );
    const said = await post(t, scope, channelId, "ship it");
    await dispatch(t, scope, said.eventId);

    const reactions = await eventsIn(t, scope, channelId, [7]);
    expect(reactions.map((r) => r.content)).toContain("👀");
    expect(reactions[0].tags.find((tag) => tag[0] === "e")?.[1]).toBe(said.eventId);
  });

  it("fails the run at send_dm and set_channel_topic rather than skipping them", async () => {
    const { t, scope, channelId } = await seed();
    for (const [id, yaml] of [
      [
        "wf_dm",
        "name: dm\ntrigger:\n  on: webhook\nsteps:\n  - id: a\n    action: send_dm\n    to: somebody\n    text: hi\n",
      ],
      [
        "wf_topic",
        "name: topic\ntrigger:\n  on: webhook\nsteps:\n  - id: a\n    action: set_channel_topic\n    topic: new\n",
      ],
    ] as const) {
      await save(t, scope, channelId, yaml, ALICE, id);
      await t.withIdentity(ALICE).mutation(workflows.trigger, { ...scope, workflowId: id });
      const runs = await runsOf(t, scope, id);
      expect(runs[0].status, id).toBe("failed");
      expect(runs[0].errorMessage, id).toMatch(/not implemented/);
    }
  });

  it("refuses a send_message that points at another room", async () => {
    const { t, scope, channelId } = await seed();
    const elsewhere = await createChannel(t, scope, "private-plans");
    await save(
      t,
      scope,
      channelId,
      `name: leak\ntrigger:\n  on: webhook\nsteps:\n  - id: a\n    action: send_message\n    channel: '${elsewhere}'\n    text: secret\n`,
      ALICE,
      "wf_leak",
    );
    await t.withIdentity(ALICE).mutation(workflows.trigger, { ...scope, workflowId: "wf_leak" });
    const runs = await runsOf(t, scope, "wf_leak");
    expect(runs[0].status).toBe("failed");
    expect(runs[0].errorMessage).toMatch(/must match the workflow's channel/);
    expect(await messagesIn(t, scope, elsewhere)).toEqual([]);
  });

  it("defers a delay and finishes it when the scheduler runs", async () => {
    const { t, scope, channelId } = await seed();
    await save(
      t,
      scope,
      channelId,
      "name: wait\ntrigger:\n  on: webhook\nsteps:\n  - id: pause\n    action: delay\n    duration: 1s\n  - id: after\n    action: send_message\n    text: awake\n",
      ALICE,
      "wf_delay",
    );
    vi.useFakeTimers();
    await t.withIdentity(ALICE).mutation(workflows.trigger, { ...scope, workflowId: "wf_delay" });

    // The step after the delay has demonstrably not happened yet.
    let runs = await runsOf(t, scope, "wf_delay");
    expect(runs[0].status).toBe("running");
    expect(await messagesIn(t, scope, channelId)).not.toContain("awake");

    await t.finishAllScheduledFunctions(vi.runAllTimers);
    runs = await runsOf(t, scope, "wf_delay");
    expect(runs[0].status).toBe("completed");
    expect(runs[0].executionTrace.map((e) => e.stepId)).toEqual(["pause", "after"]);
    expect(runs[0].executionTrace[0].output).toEqual({ slept_secs: 1 });
    expect(await messagesIn(t, scope, channelId)).toContain("awake");
  });

  it("calls a webhook, records its output, and lets a later step branch on it", async () => {
    const { t, scope, channelId } = await seed();
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await save(
      t,
      scope,
      channelId,
      `name: ci
trigger:
  on: webhook
steps:
  - id: build
    action: call_webhook
    url: 'https://ci.example.com/build'
    body: '{"commit": "{{trigger.commit}}"}'
  - id: announce
    if: 'steps_build_output_status == 200'
    action: send_message
    text: 'build said {{steps.build.output.body}}'
`,
      ALICE,
      "wf_ci",
    );
    vi.useFakeTimers();
    await t
      .withIdentity(ALICE)
      .mutation(workflows.trigger, { ...scope, workflowId: "wf_ci", inputs: { commit: "deadbeef" } });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://ci.example.com/build");
    // The body was templated; the method was not.
    expect(init.body).toBe('{"commit": "deadbeef"}');
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("manual");

    const runs = await runsOf(t, scope, "wf_ci");
    expect(runs[0].status).toBe("completed");
    expect(runs[0].executionTrace[0].output).toEqual({ status: 200, body: "ok" });
    expect(await messagesIn(t, scope, channelId)).toContain("build said ok");
  });

  it("never reaches a private destination, even when the template points at one", async () => {
    const { t, scope, channelId } = await seed();
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await save(
      t,
      scope,
      channelId,
      "name: ssrf\ntrigger:\n  on: webhook\nsteps:\n  - id: a\n    action: call_webhook\n    url: '{{trigger.target}}'\n",
      ALICE,
      "wf_ssrf",
    );
    vi.useFakeTimers();
    await t.withIdentity(ALICE).mutation(workflows.trigger, {
      ...scope,
      workflowId: "wf_ssrf",
      inputs: { target: "http://169.254.169.254/latest/meta-data" },
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(fetchMock).not.toHaveBeenCalled();
    const runs = await runsOf(t, scope, "wf_ssrf");
    expect(runs[0].status).toBe("failed");
  });
});

describe("the approval gate (§1.11)", () => {
  const GATED = `name: Deploy Approval
trigger:
  on: webhook
steps:
  - id: request
    action: request_approval
    from: any
    message: Approve deploy?
    timeout: 4h
  - id: notify_approved
    if: 'steps_request_output_approved == true'
    action: send_message
    text: Deploy approved
`;

  async function gatedRun(as = ALICE) {
    const seeded = await seed();
    await save(seeded.t, seeded.scope, seeded.channelId, GATED, ALICE, "wf_gate");
    await seeded.t
      .withIdentity(ALICE)
      .mutation(workflows.trigger, { ...seeded.scope, workflowId: "wf_gate" });
    const runs = await runsOf(seeded.t, seeded.scope, "wf_gate");
    const approvals = (await seeded.t
      .withIdentity(as)
      .query(workflows.approvalsFor, { ...seeded.scope, runId: runs[0].id })) as {
      token: string;
      status: string;
      stepId: string;
      approverSpec: string;
    }[];
    return { ...seeded, run: runs[0], approvals };
  }

  it("stops the run, and the step after the gate has not happened", async () => {
    const { t, scope, channelId, run, approvals } = await gatedRun();
    expect(run.status).toBe("waiting_approval");
    expect(approvals).toHaveLength(1);
    expect(approvals[0].status).toBe("pending");
    expect(approvals[0].stepId).toBe("request");
    // The token handed out is the *hash*; the raw token is never stored.
    expect(approvals[0].token).toMatch(/^[0-9a-f]{64}$/);
    expect(await messagesIn(t, scope, channelId)).not.toContain("Deploy approved");

    // 46010 is the one lifecycle kind with a live producer, and it is addressed.
    const requested = await eventsIn(t, scope, channelId, [KIND_WORKFLOW_APPROVAL_REQUESTED]);
    expect(requested).toHaveLength(1);
    expect(requested[0].content).toBe("Approve deploy?");
    expect(requested[0].tags.find((tag) => tag[0] === APPROVAL_TAG)?.[1]).toBe(approvals[0].token);
    expect(requested[0].tags.some((tag) => tag[0] === "p")).toBe(true);
    expect(requested[0].tags.some((tag) => tag[0] === "expiration")).toBe(true);
  });

  it("releases the run when a human grants it", async () => {
    const { t, scope, channelId, approvals } = await gatedRun();
    await t
      .withIdentity(CAROL)
      .mutation(workflows.grantApproval, { ...scope, token: approvals[0].token, note: "ship" });

    const runs = await runsOf(t, scope, "wf_gate");
    expect(runs[0].status).toBe("completed");
    expect(runs[0].executionTrace.map((e) => [e.stepId, e.status])).toEqual([
      ["request", "completed"],
      ["notify_approved", "completed"],
    ]);
    expect(runs[0].executionTrace[0].output).toMatchObject({ approved: true, note: "ship" });
    expect(await messagesIn(t, scope, channelId)).toContain("Deploy approved");
  });

  it("cancels the run when a human denies it", async () => {
    const { t, scope, channelId, approvals } = await gatedRun();
    await t
      .withIdentity(CAROL)
      .mutation(workflows.denyApproval, { ...scope, token: approvals[0].token });
    const runs = await runsOf(t, scope, "wf_gate");
    expect(runs[0].status).toBe("cancelled");
    expect(runs[0].errorMessage).toMatch(/approval denied by/);
    expect(await messagesIn(t, scope, channelId)).not.toContain("Deploy approved");
  });

  it("refuses a second act on the same approval", async () => {
    const { t, scope, approvals } = await gatedRun();
    await t
      .withIdentity(CAROL)
      .mutation(workflows.grantApproval, { ...scope, token: approvals[0].token });
    await expect(
      t.withIdentity(BOB).mutation(workflows.grantApproval, { ...scope, token: approvals[0].token }),
    ).rejects.toThrow(/already acted on/);
  });

  it("refuses a grant after the approval has expired", async () => {
    const { t, scope, channelId } = await seed();
    await save(
      t,
      scope,
      channelId,
      "name: quick\ntrigger:\n  on: webhook\nsteps:\n  - id: r\n    action: request_approval\n    from: any\n    message: ok?\n    timeout: 60\n",
      ALICE,
      "wf_exp",
    );
    await t.withIdentity(ALICE).mutation(workflows.trigger, { ...scope, workflowId: "wf_exp" });
    const runs = await runsOf(t, scope, "wf_exp");
    const approvals = (await t
      .withIdentity(ALICE)
      .query(workflows.approvalsFor, { ...scope, runId: runs[0].id })) as { token: string }[];

    // Nothing sweeps an expired approval — §1.11 is explicit that the run just
    // sits there — so expiry has to be enforced at the moment somebody acts.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 120_000);
    await expect(
      t.withIdentity(ALICE).mutation(workflows.grantApproval, { ...scope, token: approvals[0].token }),
    ).rejects.toThrow(/expired/);
  });

  it("refuses an approver spec it does not understand, fail closed", async () => {
    const { t, scope, channelId } = await seed();
    await save(
      t,
      scope,
      channelId,
      "name: role-gate\ntrigger:\n  on: webhook\nsteps:\n  - id: r\n    action: request_approval\n    from: '@engineering-lead'\n    message: ok?\n",
      ALICE,
      "wf_role",
    );
    await t.withIdentity(ALICE).mutation(workflows.trigger, { ...scope, workflowId: "wf_role" });
    const runs = await runsOf(t, scope, "wf_role");
    const approvals = (await t
      .withIdentity(ALICE)
      .query(workflows.approvalsFor, { ...scope, runId: runs[0].id })) as { token: string }[];
    await expect(
      t.withIdentity(ALICE).mutation(workflows.grantApproval, { ...scope, token: approvals[0].token }),
    ).rejects.toThrow(/not yet supported|not the named approver/);
  });

  it("names one approver when the spec is a pubkey, and refuses anyone else", async () => {
    const { t, scope, channelId } = await seed();
    await save(
      t,
      scope,
      channelId,
      `name: named\ntrigger:\n  on: webhook\nsteps:\n  - id: r\n    action: request_approval\n    from: '${pubkeyOf(CAROL)}'\n    message: ok?\n`,
      ALICE,
      "wf_named",
    );
    await t.withIdentity(ALICE).mutation(workflows.trigger, { ...scope, workflowId: "wf_named" });
    const runs = await runsOf(t, scope, "wf_named");
    const approvals = (await t
      .withIdentity(ALICE)
      .query(workflows.approvalsFor, { ...scope, runId: runs[0].id })) as { token: string }[];
    await expect(
      t.withIdentity(BOB).mutation(workflows.grantApproval, { ...scope, token: approvals[0].token }),
    ).rejects.toThrow();
    await t
      .withIdentity(CAROL)
      .mutation(workflows.grantApproval, { ...scope, token: approvals[0].token });
    expect((await runsOf(t, scope, "wf_named"))[0].status).toBe("completed");
  });
});

describe("authority cannot be escalated (§1.8)", () => {
  it("stops firing when the owner loses the role the definition needs", async () => {
    const { t, scope, channelId } = await seed();
    await t
      .withIdentity(ALICE)
      .mutation(channels.setRole, { ...scope, channelId, actorId: BOB.subject, role: "admin" });
    await save(
      t,
      scope,
      channelId,
      "name: exfil\ntrigger:\n  on: message_posted\nsteps:\n  - id: a\n    action: call_webhook\n    url: 'https://example.com/hook'\n",
      BOB,
      "wf_elev",
    );
    // While Bob is an admin it fires — posting is the door, so the run is the
    // evidence rather than the dispatcher's return value.
    await post(t, scope, channelId, "anything");
    expect(await runsOf(t, scope, "wf_elev")).toHaveLength(1);

    await t
      .withIdentity(ALICE)
      .mutation(channels.setRole, { ...scope, channelId, actorId: BOB.subject, role: "member" });
    const second = await post(t, scope, channelId, "anything else");
    expect((await dispatch(t, scope, second.eventId)).fired).toEqual([]);
    await expect(
      t.withIdentity(BOB).mutation(workflows.trigger, { ...scope, workflowId: "wf_elev" }),
    ).rejects.toThrow(/no longer has that authority/);
  });

  it("stops firing when the owner leaves the room entirely", async () => {
    const { t, scope, channelId } = await seed();
    await save(t, scope, channelId, SEND_ON_P1, CAROL, "wf_leave");
    // Posting is the door; the run is the evidence it fired.
    await post(t, scope, channelId, "P1 before");
    const firedRuns = await runsOf(t, scope, "wf_leave");
    expect(firedRuns).toHaveLength(1);

    await t.withIdentity(CAROL).mutation(channels.leave, { ...scope, channelId });
    const after = await post(t, scope, channelId, "P1 after");
    expect((await dispatch(t, scope, after.eventId)).fired).toEqual([]);
  });

  it("signs its output as the owner and tags it as a workflow's", async () => {
    const { t, scope, channelId } = await seed();
    await save(t, scope, channelId, SEND_ON_P1, CAROL, "wf_sign");
    const said = await post(t, scope, channelId, "P1 signature");
    await dispatch(t, scope, said.eventId);

    const posted = (await eventsIn(t, scope, channelId, [9])).filter((e) =>
      e.tags.some((tag) => tag[0] === WORKFLOW_TAG),
    );
    expect(posted).toHaveLength(1);
    // The run carries Carol's authority, so the log says Carol — and the tag
    // says which workflow, forever.
    expect(posted[0].pubkey).toBe(pubkeyOf(CAROL));
    expect(posted[0].tags.find((tag) => tag[0] === WORKFLOW_TAG)?.[1]).toBe("wf_sign");
  });
});

describe("the tenancy fence", () => {
  it("keeps two communities' workflows apart under the same id", async () => {
    const { t, scope, otherScope, channelId } = await seed();
    const otherChannel = await createChannel(t, otherScope, "ops");
    await save(t, scope, channelId, SEND_ON_P1, ALICE, "shared_id");
    await save(
      t,
      otherScope,
      otherChannel,
      "name: other\ntrigger:\n  on: message_posted\nsteps:\n  - id: a\n    action: send_message\n    text: other side\n",
      ALICE,
      "shared_id",
    );

    const here = (await t
      .withIdentity(ALICE)
      .query(workflows.get, { ...scope, workflowId: "shared_id" })) as { name: string };
    const there = (await t
      .withIdentity(ALICE)
      .query(workflows.get, { ...otherScope, workflowId: "shared_id" })) as { name: string };
    expect(here.name).toBe("Incident Triage");
    expect(there.name).toBe("other");

    // An event in one community fires only that community's workflow.
    const said = await post(t, scope, channelId, "P1 tenancy", ALICE);
    await dispatch(t, scope, said.eventId);
    expect(await runsOf(t, scope, "shared_id")).toHaveLength(1);
    expect(await runsOf(t, otherScope, "shared_id")).toHaveLength(0);
  });

  it("refuses somebody outside the community entirely", async () => {
    const { t, scope, channelId } = await seed();
    await save(t, scope, channelId, SEND_ON_P1, ALICE, "wf_fence");
    await expect(
      t.withIdentity(OUTSIDER).query(workflows.listForChannel, { ...scope, channelId }),
    ).rejects.toThrow();
    await expect(
      t.withIdentity(OUTSIDER).query(workflows.get, { ...scope, workflowId: "wf_fence" }),
    ).rejects.toThrow();
    await expect(save(t, scope, channelId, SEND_ON_P1, OUTSIDER, "wf_new")).rejects.toThrow();
  });

  it("refuses a workflow webhook fired against the wrong community", async () => {
    const { t, scope, otherScope, channelId } = await seed();
    const saved = await save(
      t,
      scope,
      channelId,
      "name: hook\ntrigger:\n  on: webhook\nsteps:\n  - id: a\n    action: send_message\n    text: fired\n",
      ALICE,
      "wf_cross",
    );
    expect(
      await t.mutation(workflows.fireWebhook, {
        ...otherScope,
        workflowId: "wf_cross",
        secret: saved.webhookSecret as string,
        body: {},
      }),
    ).toEqual({ status: "not_found" });
  });
});

describe("shouldFire", () => {
  it("evaluates the filter against the trigger context, and defaults to yes", async () => {
    const def = (yaml: string): WorkflowDef => {
      const parsed = parseWorkflowYaml(yaml);
      if (!parsed.ok) throw new Error(parsed.error.message);
      return parsed.value;
    };
    const context = triggerContextFromEvent(
      {
        id: "a".repeat(64),
        pubkey: "b".repeat(64),
        kind: 9,
        created_at: 1,
        tags: [],
        content: "P1 in production",
      },
      "chan",
    );
    expect(shouldFire(def(SEND_ON_P1), context)).toBe(true);
    expect(
      shouldFire(
        def(
          "name: n\ntrigger:\n  on: message_posted\n  filter: \"str_contains(trigger_text, 'P2')\"\nsteps:\n  - id: a\n    action: delay\n    duration: 1s\n",
        ),
        context,
      ),
    ).toBe(false);
    expect(
      shouldFire(
        def(
          "name: n\ntrigger:\n  on: message_posted\nsteps:\n  - id: a\n    action: delay\n    duration: 1s\n",
        ),
        context,
      ),
    ).toBe(true);
  });
});
