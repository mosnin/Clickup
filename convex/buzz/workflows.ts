// The workflow engine: storage, the four trigger doors, the execution loop,
// and the approval gate.
//
// 03-workflows-projects.md §1 is the specification and this file is the whole
// of it that is not pure — the document grammar lives in
// `src/lib/buzz/workflow-schema.ts` and the two authored-string evaluators live
// in `src/lib/buzz/workflow-expr.ts`, which says at its top why it is a security
// boundary and proves it in its tests.
//
// Three things shape everything below.
//
// **A workflow acts as somebody, and that somebody is its owner** (§1.8). The
// authority a run carries is the authority its owner holds *at the moment it
// fires*, re-read at every one of the four doors, never cached and never
// inherited from whoever poked it. `ownerAuthorityAllows` is that rule and it is
// the only place it is decided; `runPrincipal` is the same rule expressed as a
// signing key, so a run cannot write anything its owner could not have written
// by hand.
//
// **This is the general case of `convex/listAutomations.ts`, not a competitor
// to it.** The Work side's engine is one trigger, one action, evaluated inline
// inside `tasks.create`/`tasks.update` so every patch lands in one transaction.
// The shape is the same here and the reasons are the same: triggers are
// evaluated in the transaction that stored the event, actions run against the
// same cores a person's click runs against (`postMessageCore`, `reactCore`), and
// nothing re-enters a public mutation. Where it necessarily differs is that a
// workflow step can *wait* — for a clock, for an HTTP response, for a human —
// and a Convex transaction cannot. So a waiting step suspends the run into a
// row and schedules its own continuation, which is the same idea as Buzz's
// `execute_from_step(start_index, initial_outputs)` resume path with the
// suspension made durable rather than held in a task.
//
// **The log is the record.** Every lifecycle moment is a signed event through
// `publishCore` (kinds 46001–46012, §1.12), so "what did this workflow do"
// is answerable from the log by anyone who can read the room, not only from a
// runs table that a later UI phase will draw.

import { ConvexError, v } from "convex/values";
import { defineTable } from "convex/server";
import type {
  DataModelFromSchemaDefinition,
  DocumentByName,
  FunctionReference,
  GenericDatabaseReader,
  GenericDatabaseWriter,
  SchemaDefinition,
} from "convex/server";
import { anyApi, defineSchema } from "convex/server";
import type { GenericId } from "convex/values";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";
import {
  internalAction,
  internalMutation,
  mutation,
  query,
} from "../_generated/server";
import type { ActionCtx, MutationCtx, QueryCtx } from "../_generated/server";
import {
  MAX_CONCURRENT_RUNS,
  MAX_DELAY_SECS,
  WEBHOOK_MAX_RESPONSE_BYTES,
  WEBHOOK_TIMEOUT_SECS,
  canonicalJson,
  constantTimeEquals,
  cronFireInstant,
  definitionToJson,
  intervalFireInstant,
  parseDurationSecs,
  parseWorkflowYaml,
  requiresElevatedAuthority,
  stripSecret,
  webhookDestinationRefusal,
  workflowError,
  workflowRejectionMessage,
  WEBHOOK_SECRET_KEY,
  type ActionDef,
  type StepDef,
  type WorkflowDef,
  type WorkflowError,
} from "../../src/lib/buzz/workflow-schema";
import {
  ExprRefusal,
  buildEvalContext,
  emptyTriggerContext,
  evaluateCondition,
  filterAllows,
  resolveTemplate,
  type StepOutputs,
  type TriggerContext,
} from "../../src/lib/buzz/workflow-expr";
import type { ChannelPrincipal, ChannelRole } from "./channels";
import { mayGovernCommunity, requireChannelAccess } from "./channels";
import { principalForPubkey, pubkeyFor } from "./identity";
import { publishCore, type Scope } from "./log";
import { postMessageCore, reactCore } from "./messages";
import { communityNonce } from "./relay";

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

/**
 * The four tables this engine owns, declared here until they are spread into
 * `convex/schema.ts`.
 *
 * Precedent and mechanism: `buzzNotificationTables` in `./notifications.ts`.
 * Folding them in is `...buzzWorkflowTables` beside the other Chat table maps
 * and nothing else — no migration, because there are no rows yet.
 *
 * Every one is keyed `(scopeType, scopeId, …)` before anything else. That is the
 * tenancy fence in the *shape of the data*, not only in the checks: §1's first
 * cross-cutting invariant is that the same uuid may exist in two communities and
 * every lookup is `(community_id, id)`, so an index that started with the id
 * would be one forgotten `.filter()` away from answering across a boundary.
 */
export const buzzWorkflowTables = {
  buzzWorkflows: defineTable({
    scopeType: v.union(v.literal("user"), v.literal("workspace")),
    scopeId: v.string(),
    /** The canonical workflow id — the `d` tag of the kind 30620 event. */
    workflowId: v.string(),
    name: v.string(),
    /** Whose authority this workflow runs with. Pinned: an update may not change it. */
    ownerPubkey: v.string(),
    /** The room it is scoped to — the `h` tag. Pinned for the same reason. */
    channelId: v.string(),
    /** The authored YAML, kept verbatim so the editor round-trips what was written. */
    yaml: v.string(),
    /**
     * The parsed definition as canonical JSON, **including** `_webhook_secret`.
     * Opaque here and re-parsed on read, deliberately: enumerating the schema a
     * second time in a validator is how the two copies come to disagree, and
     * `parseWorkflowYaml` is total and runs on every read.
     */
    definition: v.any(),
    /** SHA-256 of `canonicalJson(definition)` — computed **after** secret injection (§1.2). */
    definitionHash: v.string(),
    status: v.union(v.literal("active"), v.literal("disabled"), v.literal("archived")),
    enabled: v.boolean(),
    /** Bumped by `rotateWebhookSecret`; the secret is derived from it. */
    secretEpoch: v.number(),
    /** Monotonic per workflow. The uniqueness a run id needs without a CSPRNG. */
    runSeq: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_scope_workflow", ["scopeType", "scopeId", "workflowId"])
    .index("by_scope_channel", ["scopeType", "scopeId", "channelId"])
    .index("by_scope_enabled", ["scopeType", "scopeId", "enabled"]),

  buzzWorkflowRuns: defineTable({
    scopeType: v.union(v.literal("user"), v.literal("workspace")),
    scopeId: v.string(),
    runId: v.string(),
    workflowId: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("running"),
      v.literal("waiting_approval"),
      v.literal("completed"),
      v.literal("failed"),
      v.literal("cancelled"),
    ),
    triggerEventId: v.optional(v.string()),
    currentStep: v.number(),
    /** `TraceEntry[]`. Opaque for the reason `definition` is. */
    executionTrace: v.any(),
    /** The `TriggerContext` the run started with, restored on every resume. */
    triggerContext: v.any(),
    startedAt: v.number(),
    completedAt: v.optional(v.number()),
    errorMessage: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_scope_run", ["scopeType", "scopeId", "runId"])
    .index("by_scope_workflow", ["scopeType", "scopeId", "workflowId", "createdAt"])
    // The capacity check ranges this. §1.9's semaphore has no queue, so the
    // question is only ever "are there already N", which is a `.take(N+1)`.
    .index("by_scope_status", ["scopeType", "scopeId", "status"])
    // At-most-once for event-triggered fires. A scheduled fire claims a row in
    // buzzWorkflowFires; an event fire needs the same property and already has
    // the record for it — a run IS the fact that this workflow fired for this
    // event. Without this the dispatcher firing twice for one event (a retry, a
    // replay, or simply being called from two places) posts twice, and the
    // second post is indistinguishable from a real one.
    .index("by_trigger_event", ["scopeType", "scopeId", "workflowId", "triggerEventId"]),

  buzzWorkflowApprovals: defineTable({
    scopeType: v.union(v.literal("user"), v.literal("workspace")),
    scopeId: v.string(),
    /**
     * SHA-256 of the raw token, hex (§1.2: `hash_approval_token`). The raw token
     * is never stored — a table of live approval tokens is a table of bearer
     * credentials, and the hash is enough to look one up.
     */
    tokenHash: v.string(),
    workflowId: v.string(),
    runId: v.string(),
    stepId: v.string(),
    stepIndex: v.number(),
    /** The YAML `from:`, already template-resolved. */
    approverSpec: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("granted"),
      v.literal("denied"),
      v.literal("expired"),
    ),
    approverPubkey: v.optional(v.string()),
    note: v.optional(v.string()),
    /** Unix **seconds**, matching the `expiration` tag on the 46010 event. */
    expiresAt: v.number(),
    createdAt: v.number(),
  })
    .index("by_scope_token", ["scopeType", "scopeId", "tokenHash"])
    .index("by_scope_run", ["scopeType", "scopeId", "runId"]),

  /**
   * The at-most-once claim for a scheduled fire (§1.10).
   *
   * One row per `(community, workflow, scheduled_for)`, inserted before any side
   * effect. If the claim wins and the run insert then fails, the row **stays**:
   * at-most-once beats exactly-once, because a duplicated fire posts a message
   * twice and a missed one does not.
   */
  buzzWorkflowFires: defineTable({
    scopeType: v.union(v.literal("user"), v.literal("workspace")),
    scopeId: v.string(),
    workflowId: v.string(),
    /** The schedule's *own* instant, in unix seconds — never `now`. */
    scheduledFor: v.number(),
    runId: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_claim", ["scopeType", "scopeId", "workflowId", "scheduledFor"])
    .index("by_scope_created", ["scopeType", "scopeId", "createdAt"]),
};

const workflowSchema = defineSchema(buzzWorkflowTables);
type WorkflowDataModel = DataModelFromSchemaDefinition<typeof workflowSchema>;

/**
 * One cast, in one place, against a data model built from the definitions above.
 *
 * Same device as `moderation.ts` and for the same reason: the generated data
 * model comes from `convex/schema.ts`, so until these tables are spread in there
 * `ctx.db.query("buzzWorkflows")` has no type. Casting once keeps every call site
 * below fully typed, indexes included, and the day the fold happens these two
 * helpers become identity functions and are deleted in one edit.
 */
function reader(ctx: QueryCtx | MutationCtx): GenericDatabaseReader<WorkflowDataModel> {
  return ctx.db as unknown as GenericDatabaseReader<WorkflowDataModel>;
}
function writer(ctx: MutationCtx): GenericDatabaseWriter<WorkflowDataModel> {
  return ctx.db as unknown as GenericDatabaseWriter<WorkflowDataModel>;
}

type WorkflowRow = DocumentByName<WorkflowDataModel, "buzzWorkflows">;
type RunRow = DocumentByName<WorkflowDataModel, "buzzWorkflowRuns">;
type ApprovalRow = DocumentByName<WorkflowDataModel, "buzzWorkflowApprovals">;

// ---------------------------------------------------------------------------
// Kinds (§1.12)
// ---------------------------------------------------------------------------

export const KIND_WORKFLOW_TRIGGERED = 46001;
export const KIND_WORKFLOW_STEP_STARTED = 46002;
export const KIND_WORKFLOW_STEP_COMPLETED = 46003;
export const KIND_WORKFLOW_STEP_FAILED = 46004;
export const KIND_WORKFLOW_COMPLETED = 46005;
export const KIND_WORKFLOW_FAILED = 46006;
export const KIND_WORKFLOW_CANCELLED = 46007;
export const KIND_WORKFLOW_APPROVAL_REQUESTED = 46010;
export const KIND_WORKFLOW_APPROVAL_GRANTED = 46011;
export const KIND_WORKFLOW_APPROVAL_DENIED = 46012;

const KIND_STREAM_MESSAGE = 9;
const KIND_REACTION = 7;
const KIND_STREAM_MESSAGE_DIFF = 40008;

/**
 * §1.10's loop prevention, in two halves.
 *
 * The band 46001–46012 never triggers anything — a run that reported a step
 * would otherwise fire the workflow that reported it. And a message a workflow
 * posted carries `["buzz:workflow", <id>]`, which is the second half: the
 * message is an ordinary kind 9 to every other reader, and only the trigger path
 * treats the tag as meaning "this one is mine, do not answer it".
 */
export function isWorkflowExecutionKind(kind: number): boolean {
  return kind >= 46001 && kind <= 46012;
}

/** The provenance tag every event a run publishes carries. */
export const WORKFLOW_TAG = "buzz:workflow";

/**
 * **Inconsistency 1 of 2, decided here.** §1.11 records that Buzz's relay and
 * SDK reference an approval by a `d` (or `e`) tag while the desktop builder
 * writes `t`. We implement **`d`, and only `d`.**
 *
 * Why `d`: it is what two of the three implementations already write, so it is
 * the form an event exported from this log has the best chance of being
 * understood by; it is NIP-33's *identifier* tag, which is what an approval
 * token hash is; and `_kinds.ts` already projects `d` as a coordinate, so the
 * lookup is an index range rather than a scan. Why not `t`: in Nostr `t` is a
 * topic/hashtag, and this repo already uses it that way (§2.2's PR review
 * labels), so an approval id filed under `t` would sit in the same index as
 * free-text labels anybody can write.
 *
 * `e` is deliberately *not* also accepted. "Either tag works" is how a reference
 * stops being checkable: two writers, two readers, and the first one to be
 * updated silently stops matching the other.
 */
export const APPROVAL_TAG = "d";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const scopeArgs = {
  scopeType: v.union(v.literal("user"), v.literal("workspace")),
  scopeId: v.string(),
};

function sha256Hex(input: string): string {
  return bytesToHex(sha256(utf8ToBytes(input)));
}

function refuse(error: WorkflowError): never {
  throw new ConvexError(workflowRejectionMessage(error));
}

/** A workflow id is a name in an index, so it is constrained like one. */
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

async function workflowRow(
  ctx: QueryCtx | MutationCtx,
  scope: Scope,
  workflowId: string,
): Promise<WorkflowRow | null> {
  return await reader(ctx)
    .query("buzzWorkflows")
    .withIndex("by_scope_workflow", (q) =>
      q.eq("scopeType", scope.scopeType).eq("scopeId", scope.scopeId).eq("workflowId", workflowId),
    )
    .unique();
}

async function runRow(
  ctx: QueryCtx | MutationCtx,
  scope: Scope,
  runId: string,
): Promise<RunRow | null> {
  return await reader(ctx)
    .query("buzzWorkflowRuns")
    .withIndex("by_scope_run", (q) =>
      q.eq("scopeType", scope.scopeType).eq("scopeId", scope.scopeId).eq("runId", runId),
    )
    .unique();
}

function scopeOf(row: { scopeType: "user" | "workspace"; scopeId: string }): Scope {
  return { scopeType: row.scopeType, scopeId: row.scopeId };
}

/**
 * The stored definition, back as a typed one.
 *
 * Re-parsed from the YAML rather than trusted from the JSON column, so a row
 * written by an older build is read through today's validator. §1.13's rule —
 * "a malformed workflow must not break the list" — is honoured by the callers
 * that *list*: they tolerate `null`. The callers that *run* refuse on `null`,
 * which is the same rule pointing the other way.
 */
function definitionOf(row: WorkflowRow): WorkflowDef | null {
  const parsed = parseWorkflowYaml(row.yaml);
  return parsed.ok ? parsed.value : null;
}

// ---------------------------------------------------------------------------
// Authority (§1.8)
// ---------------------------------------------------------------------------

/**
 * The escalation rule, stated once: **a workflow may do exactly what its owner
 * may do, at the moment it does it.**
 *
 * Two halves, and both are needed.
 *
 *   - *Capability*: the owner must still be an active member of the room the
 *     workflow is scoped to, and a definition that `requiresElevatedAuthority`
 *     (any `call_webhook` — the one action that can move room content to a
 *     destination its author chose) additionally needs `owner`/`admin`. So an
 *     admin who writes an exfiltrating workflow and is then demoted has written
 *     a workflow that stops firing; the definition is not a stored grant.
 *   - *Identity*: `runPrincipal` signs and posts **as the owner**, through the
 *     same `postMessageCore`/`reactCore` a person's click goes through — which
 *     re-checks the room is writable and that the author is in it. There is no
 *     privileged write path for a workflow to reach that a member could not.
 *
 * Fail-closed everywhere: a missing key row, a missing principal, a missing
 * membership and a lookup that throws all deny. A run that cannot establish
 * whose authority it carries has no authority.
 */
export async function ownerAuthorityAllows(
  ctx: QueryCtx | MutationCtx,
  scope: Scope,
  workflow: WorkflowRow,
  def: WorkflowDef,
): Promise<boolean> {
  try {
    const principal = await principalForPubkey(ctx, workflow.ownerPubkey);
    if (!principal) return false;
    // A rotated key still names its principal (that is what `principalForPubkey`
    // is for), but authority is about *now*: the owner must currently sign with
    // this pubkey, or the workflow is running under a retired identity.
    const live = await pubkeyFor(ctx, principal.type, principal.id);
    if (live !== workflow.ownerPubkey) return false;

    const role = await channelRoleOf(ctx, scope, workflow.channelId, principal.id);
    if (role === null) return false;
    if (!requiresElevatedAuthority(def)) return true;
    if (role === "owner" || role === "admin") return true;
    // The community governor is kept as a second answer for the reason
    // `channels.mayGovernChannel` keeps it: a workspace owner must not be locked
    // out of a room inside their own workspace. Only a person can be one.
    if (principal.type !== "user") return false;
    return await mayGovernCommunity(ctx, scope, principal.id);
  } catch {
    return false;
  }
}

/** The role an actor currently holds in a room, or null if it is not in it. */
async function channelRoleOf(
  ctx: QueryCtx | MutationCtx,
  scope: Scope,
  channelId: string,
  actorId: string,
): Promise<ChannelRole | null> {
  const membership = await ctx.db
    .query("buzzMemberships")
    .withIndex("by_channel_actor", (q) =>
      q
        .eq("scopeType", scope.scopeType)
        .eq("scopeId", scope.scopeId)
        .eq("channelId", channelId)
        .eq("actorId", actorId),
    )
    .unique();
  if (!membership || membership.removedAt !== undefined) return null;
  return membership.role;
}

/**
 * The owner, in the shape every write core here takes.
 *
 * §1.9 has the *relay* sign a workflow's messages and carry the owner's pubkey
 * as an attribution tag. We sign as the **owner** instead, and the divergence is
 * deliberate rather than incidental:
 *
 *   - Buzz's relay signs because it cannot do anything else — it holds no user's
 *     private key. We hold every principal's key by construction (D3), so the
 *     workaround's reason is absent here.
 *   - `relay.asRelay` refuses to sign anything that is not a `relaySigned` kind,
 *     and states why: an ordinary message that appears to come from the room
 *     itself is the most authoritative-looking object in the product. Signing
 *     workflow output as the relay would mean bypassing that fence, in this file,
 *     for kind 9.
 *   - §1.8 already says the run *acts with* the owner's authority. Having it also
 *     carry the owner's signature makes the log say the true thing rather than a
 *     narrower one, and the `["buzz:workflow", id]` tag keeps "a workflow wrote
 *     this" distinguishable forever, which is the property the relay signature
 *     was buying.
 */
async function runPrincipal(
  ctx: QueryCtx | MutationCtx,
  workflow: WorkflowRow,
): Promise<ChannelPrincipal> {
  const principal = await principalForPubkey(ctx, workflow.ownerPubkey);
  if (!principal) refuse(workflowError("Unauthorized", "workflow owner has no identity"));
  let name = principal.id;
  if (principal.type === "user") {
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", principal.id))
      .unique();
    name = user?.name ?? user?.email ?? principal.id;
  } else {
    const agentId = ctx.db.normalizeId("agents", principal.id);
    const agent = agentId ? await ctx.db.get(agentId) : null;
    name = agent?.name ?? principal.id;
  }
  return {
    actor: { type: principal.type, id: principal.id, name },
    actorType: principal.type,
    actorId: principal.id,
  };
}

// ---------------------------------------------------------------------------
// Saving a workflow (§1.2, §1.7, §1.8)
// ---------------------------------------------------------------------------

/**
 * §1.7: the webhook secret, derived rather than random.
 *
 * A Convex mutation has no CSPRNG — the constraint `relay.ts` documents at
 * length — so the secret is a keyed hash of the deployment seed, the community
 * and the workflow id. The seed is a deployment secret no query returns and no
 * row holds, so the value is unpredictable to anyone who does not have it even
 * though its other inputs are public. `secretEpoch` is what makes rotation
 * possible: "if it is lost, re-save the workflow to generate a new one" becomes
 * "bump the epoch", and the old secret stops verifying the moment it does.
 */
function webhookSecretFor(scope: Scope, workflowId: string, epoch: number): string {
  return communityNonce(scope, `workflow-webhook-secret:${workflowId}:${epoch}`);
}

/**
 * Create or replace a workflow.
 *
 * The ordering contract §1.2 calls load-bearing is in the two lines that build
 * `definition`: the secret is injected **first**, then `definitionHash` is taken
 * over the result — so the hash names the definition the engine will run rather
 * than the text the author submitted, and a run can be tied back to bytes that
 * include the credential it was authorised with.
 */
export const save = mutation({
  args: {
    ...scopeArgs,
    channelId: v.string(),
    yaml: v.string(),
    /** Client-chosen, like Buzz's `d` tag. Derived when absent. */
    workflowId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const { subject, membership } = await requireChannelAccess(ctx, scope, args.channelId);
    if (!membership) throw new ConvexError("You are not in this channel");

    const parsed = parseWorkflowYaml(args.yaml);
    if (!parsed.ok) refuse(parsed.error);
    const def = parsed.value;

    // §1.8's save-time half. An ordinary member may automate their room; only an
    // owner or admin may point an automation at the open internet.
    if (requiresElevatedAuthority(def)) {
      const elevated =
        membership.role === "owner" ||
        membership.role === "admin" ||
        (await mayGovernCommunity(ctx, scope, subject));
      if (!elevated) {
        refuse(
          workflowError(
            "Unauthorized",
            "a workflow that calls a webhook can only be saved by a channel owner or admin",
          ),
        );
      }
    }

    const ownerPubkey = await pubkeyFor(ctx, "user", subject);
    if (!ownerPubkey) throw new ConvexError("You have no Chat identity yet");

    const now = Date.now();
    const workflowId = args.workflowId ?? communityNonce(scope, `workflow-id:${args.channelId}:${now}`).slice(0, 32);
    if (!ID_RE.test(workflowId)) {
      refuse(workflowError("InvalidDefinition", "workflow id must be 1..64 of [A-Za-z0-9_-]"));
    }

    const existing = await workflowRow(ctx, scope, workflowId);
    if (existing) {
      // Ownership is pinned (§1.8). Neither the owner nor the room may change on
      // an update: both are what the authority re-check is *about*, so a save
      // that could move either would be a save that could re-point a workflow at
      // a room its author cannot reach.
      if (existing.ownerPubkey !== ownerPubkey) {
        refuse(workflowError("Unauthorized", "this workflow belongs to somebody else"));
      }
      if (existing.channelId !== args.channelId) {
        refuse(workflowError("Unauthorized", "a workflow cannot be moved to another channel"));
      }
    }

    const isWebhook = def.trigger.on === "webhook";
    const epoch = existing?.secretEpoch ?? 1;
    const secret = isWebhook ? webhookSecretFor(scope, workflowId, epoch) : null;
    const definition: Record<string, unknown> = {
      ...definitionToJson(def),
      ...(secret === null ? {} : { [WEBHOOK_SECRET_KEY]: secret }),
    };
    const definitionHash = sha256Hex(canonicalJson(definition));

    if (existing) {
      await writer(ctx).patch(existing._id, {
        name: def.name,
        yaml: args.yaml,
        definition,
        definitionHash,
        enabled: def.enabled,
        updatedAt: now,
      });
    } else {
      await writer(ctx).insert("buzzWorkflows", {
        scopeType: scope.scopeType,
        scopeId: scope.scopeId,
        workflowId,
        name: def.name,
        ownerPubkey,
        channelId: args.channelId,
        yaml: args.yaml,
        definition,
        definitionHash,
        status: "active",
        enabled: def.enabled,
        secretEpoch: epoch,
        runSeq: 0,
        createdAt: now,
        updatedAt: now,
      });
    }

    // §1.7: the secret is returned **only** the first time a workflow gains a
    // webhook trigger, and never by a read. A caller who loses it rotates.
    const firstWebhookSave =
      secret !== null && (!existing || !hasSecret(existing.definition));
    return {
      workflowId,
      webhookSecret: firstWebhookSave ? secret : null,
      definitionHash,
    };
  },
});

function hasSecret(definition: unknown): boolean {
  return (
    typeof definition === "object" &&
    definition !== null &&
    Object.prototype.hasOwnProperty.call(definition, WEBHOOK_SECRET_KEY)
  );
}

/** Bump the epoch, mint a new secret, and hand it back once. */
export const rotateWebhookSecret = mutation({
  args: { ...scopeArgs, workflowId: v.string() },
  handler: async (ctx, args) => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const workflow = await requireOwnedWorkflow(ctx, scope, args.workflowId);
    const def = definitionOf(workflow);
    if (!def || def.trigger.on !== "webhook") {
      refuse(workflowError("InvalidDefinition", "this workflow is not webhook-triggered"));
    }
    const epoch = workflow.secretEpoch + 1;
    const secret = webhookSecretFor(scope, workflow.workflowId, epoch);
    const definition = { ...(workflow.definition as Record<string, unknown>), [WEBHOOK_SECRET_KEY]: secret };
    await writer(ctx).patch(workflow._id, {
      secretEpoch: epoch,
      definition,
      definitionHash: sha256Hex(canonicalJson(definition)),
      updatedAt: Date.now(),
    });
    return { webhookSecret: secret };
  },
});

/** The owner, or a refusal. Used by every mutation that changes a workflow. */
async function requireOwnedWorkflow(
  ctx: MutationCtx,
  scope: Scope,
  workflowId: string,
): Promise<WorkflowRow> {
  const workflow = await workflowRow(ctx, scope, workflowId);
  if (!workflow) throw new ConvexError("Workflow not found");
  // The tenancy fence *and* the room fence: a workflow is only reachable by
  // somebody who can reach the room it is scoped to.
  const { subject } = await requireChannelAccess(ctx, scope, workflow.channelId);
  const ownerPubkey = await pubkeyFor(ctx, "user", subject);
  if (ownerPubkey !== workflow.ownerPubkey) {
    refuse(workflowError("Unauthorized", "this workflow belongs to somebody else"));
  }
  return workflow;
}

export const setStatus = mutation({
  args: {
    ...scopeArgs,
    workflowId: v.string(),
    status: v.union(v.literal("active"), v.literal("disabled"), v.literal("archived")),
  },
  handler: async (ctx, args) => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const workflow = await requireOwnedWorkflow(ctx, scope, args.workflowId);
    await writer(ctx).patch(workflow._id, { status: args.status, updatedAt: Date.now() });
  },
});

/**
 * "Delete \"<name>\". This will stop all future triggers and remove the
 * workflow permanently."
 *
 * The runs are **not** deleted with it. A run is the record of something that
 * actually happened — messages were posted, a webhook was called, a person
 * approved something — and deleting the definition does not un-happen any of it.
 */
export const remove = mutation({
  args: { ...scopeArgs, workflowId: v.string() },
  handler: async (ctx, args) => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const workflow = await requireOwnedWorkflow(ctx, scope, args.workflowId);
    await writer(ctx).delete(workflow._id);
  },
});

// ---------------------------------------------------------------------------
// Reads (§1.13)
// ---------------------------------------------------------------------------

type WorkflowView = {
  id: string;
  name: string;
  ownerPubkey: string;
  channelId: string;
  definition: Record<string, unknown>;
  status: "active" | "disabled" | "archived";
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
};

/**
 * The wire shape, with the secret removed on the way out (§1.7 `strip_secret`).
 *
 * Stripped here, in the one projection every read goes through, rather than at
 * each query — a second read surface that forgot would publish a bearer
 * credential to every member of the room.
 */
function toView(row: WorkflowRow): WorkflowView {
  return {
    id: row.workflowId,
    name: row.name,
    ownerPubkey: row.ownerPubkey,
    channelId: row.channelId,
    definition: stripSecret((row.definition ?? {}) as Record<string, unknown>),
    status: row.status,
    enabled: row.enabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export const listForChannel = query({
  args: { ...scopeArgs, channelId: v.string() },
  handler: async (ctx, args) => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    await requireChannelAccess(ctx, scope, args.channelId);
    const rows = await reader(ctx)
      .query("buzzWorkflows")
      .withIndex("by_scope_channel", (q) =>
        q
          .eq("scopeType", scope.scopeType)
          .eq("scopeId", scope.scopeId)
          .eq("channelId", args.channelId),
      )
      .collect();
    return rows.map(toView);
  },
});

export const get = query({
  args: { ...scopeArgs, workflowId: v.string() },
  handler: async (ctx, args) => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const workflow = await workflowRow(ctx, scope, args.workflowId);
    if (!workflow) return null;
    await requireChannelAccess(ctx, scope, workflow.channelId);
    return toView(workflow);
  },
});

export const runsFor = query({
  args: { ...scopeArgs, workflowId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const workflow = await workflowRow(ctx, scope, args.workflowId);
    if (!workflow) return [];
    await requireChannelAccess(ctx, scope, workflow.channelId);
    const limit = Math.min(Math.max(args.limit ?? 100, 1), 1000);
    const rows = await reader(ctx)
      .query("buzzWorkflowRuns")
      .withIndex("by_scope_workflow", (q) =>
        q
          .eq("scopeType", scope.scopeType)
          .eq("scopeId", scope.scopeId)
          .eq("workflowId", args.workflowId),
      )
      .order("desc")
      .take(limit);
    return rows.map((row) => ({
      id: row.runId,
      workflowId: row.workflowId,
      status: row.status,
      currentStep: row.currentStep,
      executionTrace: (row.executionTrace ?? []) as TraceEntry[],
      startedAt: row.startedAt,
      completedAt: row.completedAt ?? null,
      errorMessage: row.errorMessage ?? null,
      createdAt: row.createdAt,
    }));
  },
});

export const approvalsFor = query({
  args: { ...scopeArgs, runId: v.string() },
  handler: async (ctx, args) => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const run = await runRow(ctx, scope, args.runId);
    if (!run) return [];
    const workflow = await workflowRow(ctx, scope, run.workflowId);
    if (!workflow) return [];
    await requireChannelAccess(ctx, scope, workflow.channelId);
    const rows = await reader(ctx)
      .query("buzzWorkflowApprovals")
      .withIndex("by_scope_run", (q) =>
        q.eq("scopeType", scope.scopeType).eq("scopeId", scope.scopeId).eq("runId", args.runId),
      )
      .collect();
    return rows.map(toApprovalView);
  },
});

function toApprovalView(row: ApprovalRow) {
  return {
    // The hash *is* the public handle (§1.11) — the raw token is never stored
    // and never returned, so this is the id an approval is granted by.
    token: row.tokenHash,
    workflowId: row.workflowId,
    runId: row.runId,
    stepId: row.stepId,
    stepIndex: row.stepIndex,
    approverSpec: row.approverSpec,
    status: row.status,
    approverPubkey: row.approverPubkey ?? null,
    note: row.note ?? null,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  };
}

// ---------------------------------------------------------------------------
// The trace
// ---------------------------------------------------------------------------

export type TraceEntry = {
  stepId: string;
  status: "completed" | "failed" | "skipped" | "waiting_approval" | "running";
  output: Record<string, unknown>;
  startedAt: number | null;
  completedAt: number | null;
  error: string | null;
};

/**
 * Rebuild `step_outputs` from the trace (§1.11's resume path does exactly this).
 *
 * The trace is the single source of what earlier steps produced, so a resume
 * needs nothing carried across the suspension except the run row itself — which
 * is what makes a suspension survivable at all on a substrate where the process
 * that started the run is long gone by the time a human approves.
 */
function outputsFromTrace(trace: TraceEntry[]): StepOutputs {
  const outputs: StepOutputs = {};
  for (const entry of trace) {
    if (entry.status === "completed") outputs[entry.stepId] = entry.output ?? {};
  }
  return outputs;
}

// ---------------------------------------------------------------------------
// Lifecycle events (§1.12)
// ---------------------------------------------------------------------------

async function emitLifecycle(
  ctx: MutationCtx,
  scope: Scope,
  workflow: WorkflowRow,
  kind: number,
  tags: string[][],
  content: string,
): Promise<void> {
  try {
    const principal = await runPrincipal(ctx, workflow);
    await publishCore(ctx, {
      actor: principal.actor,
      scope,
      kind,
      tags: [["h", workflow.channelId], ...tags, [WORKFLOW_TAG, workflow.workflowId]],
      content,
    });
  } catch {
    // A lifecycle event is the *record* of the run, not part of it. A run that
    // did its work and could not describe itself is still a run that did its
    // work, and failing it here would turn an observability problem into a
    // correctness one. The runs table is the other copy, and it is written in
    // the same transaction.
  }
}

// ---------------------------------------------------------------------------
// The execution loop (§1.9)
// ---------------------------------------------------------------------------

/** Where the loop stopped, and why. */
type LoopOutcome =
  | { kind: "completed" }
  | { kind: "failed"; error: WorkflowError; stepId?: string }
  | { kind: "waiting" }
  | { kind: "deferred" };

/**
 * Run the steps from `startIndex`, and finalize.
 *
 * The single place a step becomes a trace entry and the single place a result
 * becomes a run status (§1.9's `finalize_run` rule) — every door and every
 * resume path funnels here, so a run's status can never be set by two functions
 * that disagree about what "done" means.
 */
async function advanceRun(
  ctx: MutationCtx,
  run: RunRow,
  startIndex: number,
): Promise<void> {
  const scope = scopeOf(run);
  const workflow = await workflowRow(ctx, scope, run.workflowId);
  if (!workflow) {
    await finishRun(ctx, scope, null, run, "failed", "workflow no longer exists");
    return;
  }
  const def = definitionOf(workflow);
  if (!def) {
    await finishRun(ctx, scope, workflow, run, "failed", "workflow definition no longer parses");
    return;
  }

  const trigger = (run.triggerContext ?? emptyTriggerContext()) as TriggerContext;
  const trace: TraceEntry[] = [...((run.executionTrace ?? []) as TraceEntry[])];
  const principal = await runPrincipal(ctx, workflow);

  let outcome: LoopOutcome = { kind: "completed" };
  let index = startIndex;

  for (; index < def.steps.length; index += 1) {
    const step = def.steps[index];
    const startedAt = Date.now();

    // (a) the condition.
    if (step.if !== undefined && step.if.trim() !== "") {
      let allowed: boolean;
      try {
        allowed = evaluateCondition(step.if, buildEvalContext(trigger, outputsFromTrace(trace)));
      } catch (err) {
        outcome = { kind: "failed", error: asWorkflowError(err, "ConditionError"), stepId: step.id };
        break;
      }
      if (!allowed) {
        // §1.6: a false `if:` is not a failure. The trace says `skipped` and the
        // run keeps going, which is what makes a two-branch workflow (§1.14's
        // approval fixture) express a branch at all.
        trace.push({
          stepId: step.id,
          status: "skipped",
          output: {},
          startedAt,
          completedAt: Date.now(),
          error: null,
        });
        continue;
      }
    }

    await emitLifecycle(
      ctx,
      scope,
      workflow,
      KIND_WORKFLOW_STEP_STARTED,
      [["d", run.runId], ["step", step.id], ["index", String(index)]],
      JSON.stringify({ step_id: step.id, status: "running" }),
    );

    // (b) templates. `method` and `delay.duration` are deliberately not
    //     templated (§1.9) — a method chosen at runtime is a GET that becomes a
    //     DELETE, and a delay chosen at runtime is a cap that cannot be checked
    //     when the workflow is read.
    let action: ActionDef;
    try {
      action = resolveActionTemplates(step.action, trigger, outputsFromTrace(trace));
    } catch (err) {
      outcome = { kind: "failed", error: asWorkflowError(err, "TemplateError"), stepId: step.id };
      break;
    }

    // (c) dispatch.
    const result = await dispatchStep(ctx, {
      scope,
      workflow,
      def,
      run,
      principal,
      step,
      action,
      index,
      trigger,
    });

    if (result.kind === "completed") {
      trace.push({
        stepId: step.id,
        status: "completed",
        output: result.output,
        startedAt,
        completedAt: Date.now(),
        error: null,
      });
      await emitLifecycle(
        ctx,
        scope,
        workflow,
        KIND_WORKFLOW_STEP_COMPLETED,
        [["d", run.runId], ["step", step.id], ["index", String(index)]],
        JSON.stringify({ step_id: step.id, status: "completed", output: result.output }),
      );
      continue;
    }

    if (result.kind === "failed") {
      outcome = { kind: "failed", error: result.error, stepId: step.id };
      break;
    }

    if (result.kind === "waiting") {
      trace.push({
        stepId: step.id,
        status: "waiting_approval",
        output: {},
        startedAt,
        completedAt: null,
        error: null,
      });
      outcome = { kind: "waiting" };
      break;
    }

    // Deferred: the step has begun and will finish in a scheduled continuation.
    // The trace entry is written when it finishes, not now — a trace that
    // claimed a completed step before its webhook answered would be a trace that
    // lies for the length of the call.
    outcome = { kind: "deferred" };
    break;
  }

  const now = Date.now();
  if (outcome.kind === "completed") {
    await writer(ctx).patch(run._id, {
      status: "completed",
      currentStep: def.steps.length,
      executionTrace: trace,
      completedAt: now,
    });
    await emitLifecycle(
      ctx,
      scope,
      workflow,
      KIND_WORKFLOW_COMPLETED,
      [["d", run.runId], ["workflow", workflow.workflowId], ["p", workflow.ownerPubkey]],
      "{}",
    );
    return;
  }

  if (outcome.kind === "failed") {
    const message = outcome.error.message;
    await writer(ctx).patch(run._id, {
      status: "failed",
      currentStep: index,
      executionTrace: [
        ...trace,
        {
          stepId: outcome.stepId ?? "",
          status: "failed",
          output: {},
          startedAt: now,
          completedAt: now,
          error: message,
        },
      ],
      completedAt: now,
      errorMessage: message,
    });
    await emitLifecycle(
      ctx,
      scope,
      workflow,
      KIND_WORKFLOW_STEP_FAILED,
      [["d", run.runId], ["step", outcome.stepId ?? ""], ["index", String(index)]],
      JSON.stringify({ step_id: outcome.stepId ?? "", status: "failed", error: message }),
    );
    await emitLifecycle(
      ctx,
      scope,
      workflow,
      KIND_WORKFLOW_FAILED,
      [["d", run.runId], ["workflow", workflow.workflowId], ["p", workflow.ownerPubkey]],
      JSON.stringify({ error: message, kind: outcome.error.kind }),
    );
    return;
  }

  await writer(ctx).patch(run._id, {
    status: outcome.kind === "waiting" ? "waiting_approval" : "running",
    currentStep: index,
    executionTrace: trace,
  });
}

function asWorkflowError(err: unknown, fallbackKind: WorkflowError["kind"]): WorkflowError {
  if (err instanceof ExprRefusal) return err.workflow;
  if (err instanceof Error) return workflowError(fallbackKind, err.message);
  return workflowError(fallbackKind, String(err));
}

async function finishRun(
  ctx: MutationCtx,
  scope: Scope,
  workflow: WorkflowRow | null,
  run: RunRow,
  status: "failed" | "cancelled",
  message: string,
): Promise<void> {
  await writer(ctx).patch(run._id, {
    status,
    completedAt: Date.now(),
    errorMessage: message,
  });
  if (!workflow) return;
  await emitLifecycle(
    ctx,
    scope,
    workflow,
    status === "cancelled" ? KIND_WORKFLOW_CANCELLED : KIND_WORKFLOW_FAILED,
    [["d", run.runId], ["workflow", workflow.workflowId], ["p", workflow.ownerPubkey]],
    JSON.stringify({ error: message }),
  );
}

// ---------------------------------------------------------------------------
// The action sink (§1.9)
// ---------------------------------------------------------------------------

type StepResult =
  | { kind: "completed"; output: Record<string, unknown> }
  | { kind: "failed"; error: WorkflowError }
  | { kind: "waiting" }
  | { kind: "deferred" };

type DispatchArgs = {
  scope: Scope;
  workflow: WorkflowRow;
  def: WorkflowDef;
  run: RunRow;
  principal: ChannelPrincipal;
  step: StepDef;
  action: ActionDef;
  index: number;
  trigger: TriggerContext;
};

/**
 * The seam every side effect goes through — Buzz's `ActionSink`, in the one
 * shape our substrate allows.
 *
 * Two of the seven actions cannot finish inside a transaction: `delay` needs a
 * clock and `call_webhook` needs the network, and a Convex mutation has neither.
 * Both therefore *begin* here and finish in a scheduled continuation, which is
 * the same suspend/resume machinery the approval gate needs anyway — so there is
 * one waiting mechanism rather than three.
 */
async function dispatchStep(ctx: MutationCtx, args: DispatchArgs): Promise<StepResult> {
  const { action } = args;
  switch (action.action) {
    case "send_message":
      return await sendMessageStep(ctx, args, action);

    case "add_reaction": {
      if (args.trigger.messageId === "") {
        return {
          kind: "failed",
          error: workflowError("InvalidDefinition", "add_reaction: trigger has no message id"),
        };
      }
      try {
        const result = await reactCore(
          ctx,
          args.scope,
          args.workflow.channelId,
          args.principal,
          { targetId: args.trigger.messageId, emoji: action.emoji },
        );
        return { kind: "completed", output: { added: result.added, event_id: result.eventId } };
      } catch (err) {
        return { kind: "failed", error: asWorkflowError(err, "Database") };
      }
    }

    case "delay": {
      const secs = parseDurationSecs(action.duration);
      if (secs === null) {
        return {
          kind: "failed",
          error: workflowError("InvalidDefinition", `invalid duration: ${action.duration}`),
        };
      }
      // §1.3: capped below the default step timeout on purpose. A delay that
      // could outlast its own timeout would fail at the top of its range.
      const capped = Math.min(secs, MAX_DELAY_SECS);
      await ctx.scheduler.runAfter(capped * 1000, selfRef.resumeDeferred, {
        scopeType: args.scope.scopeType,
        scopeId: args.scope.scopeId,
        runId: args.run.runId,
        stepIndex: args.index,
        output: { slept_secs: capped },
      });
      return { kind: "deferred" };
    }

    case "call_webhook": {
      const refusal = webhookDestinationRefusal(action.url);
      if (refusal) {
        return { kind: "failed", error: workflowError("WebhookError", refusal) };
      }
      await ctx.scheduler.runAfter(0, selfRef.callWebhook, {
        scopeType: args.scope.scopeType,
        scopeId: args.scope.scopeId,
        runId: args.run.runId,
        stepIndex: args.index,
        url: action.url,
        method: action.method,
        headers: action.headers,
        body: action.body ?? "",
        timeoutSecs: Math.min(args.step.timeoutSecs ?? WEBHOOK_TIMEOUT_SECS, WEBHOOK_TIMEOUT_SECS),
      });
      return { kind: "deferred" };
    }

    case "request_approval":
      return await requestApprovalStep(ctx, args, action);

    // §1.3: both are `NotImplemented` in Buzz and a run reaching one fails. Kept
    // as a real failure rather than quietly skipped — a workflow whose author
    // believes it sends a DM, and which silently does not, is worse than one
    // that stops and says so.
    case "send_dm":
      return {
        kind: "failed",
        error: workflowError("NotImplemented", "send_dm is not implemented"),
      };
    case "set_channel_topic":
      return {
        kind: "failed",
        error: workflowError("NotImplemented", "set_channel_topic is not implemented"),
      };
  }
}

/**
 * §1.9's `resolve_send_message_channel`, and it is an escalation fence.
 *
 * The workflow's own channel always wins, and an explicit `channel:` override
 * must equal it. Without that rule a member of one room could author a workflow
 * that posts into another — which is precisely the escalation §1.8 exists to
 * prevent, reached through a field rather than through a permission.
 */
async function sendMessageStep(
  ctx: MutationCtx,
  args: DispatchArgs,
  action: { action: "send_message"; text: string; channel?: string },
): Promise<StepResult> {
  let channelId = args.workflow.channelId;
  if (channelId !== "") {
    if (action.channel !== undefined && action.channel !== "" && action.channel !== channelId) {
      return {
        kind: "failed",
        error: workflowError(
          "Unauthorized",
          "send_message channel override must match the workflow's channel",
        ),
      };
    }
  } else if (action.channel) {
    channelId = action.channel;
  } else if (args.trigger.channelId !== "") {
    channelId = args.trigger.channelId;
  } else {
    return {
      kind: "failed",
      error: workflowError("InvalidDefinition", "no channel_id available"),
    };
  }

  try {
    const posted = await postMessageCore(ctx, args.scope, channelId, args.principal, {
      body: action.text,
      kind: KIND_STREAM_MESSAGE,
      // The loop-prevention tag, and the provenance one. Same tag, both jobs:
      // `onEventCore` refuses to answer an event carrying it, and a reader can
      // see which workflow said this.
      extraTags: [[WORKFLOW_TAG, args.workflow.workflowId]],
    });
    return { kind: "completed", output: { sent: true, event_id: posted.eventId } };
  } catch (err) {
    return { kind: "failed", error: asWorkflowError(err, "Database") };
  }
}

/**
 * §1.11: mint a token, store its **hash**, publish 46010, and stop.
 *
 * The token is derived rather than random for the reason `webhookSecretFor`
 * gives — a mutation has no CSPRNG. Buzz's own note says run id and step id are
 * deliberately not mixed into its uuid because *time-derived* entropy would be
 * predictable; ours mixes them into a keyed hash whose key is a deployment
 * secret that no query returns and no row holds, so the inputs being known does
 * not make the output guessable. That is the same argument `relay.ts` makes for
 * the community relay key, and it is the strongest one available in a
 * deterministic isolate.
 */
async function requestApprovalStep(
  ctx: MutationCtx,
  args: DispatchArgs,
  action: { action: "request_approval"; from: string; message: string; timeout: string },
): Promise<StepResult> {
  const timeoutSecs = parseDurationSecs(action.timeout);
  if (timeoutSecs === null) {
    return {
      kind: "failed",
      error: workflowError("InvalidDefinition", `invalid timeout: ${action.timeout}`),
    };
  }
  const token = communityNonce(
    args.scope,
    `workflow-approval:${args.run.runId}:${args.step.id}:${args.workflow.secretEpoch}`,
  );
  const tokenHash = sha256Hex(token);
  const nowSecs = Math.floor(Date.now() / 1000);
  const expiresAt = nowSecs + timeoutSecs;

  await writer(ctx).insert("buzzWorkflowApprovals", {
    scopeType: args.scope.scopeType,
    scopeId: args.scope.scopeId,
    tokenHash,
    workflowId: args.workflow.workflowId,
    runId: args.run.runId,
    stepId: args.step.id,
    stepIndex: args.index,
    approverSpec: action.from,
    status: "pending",
    expiresAt,
    createdAt: Date.now(),
  });

  // §1.12: 46010 is the one lifecycle kind with a live producer, and the `p` tag
  // is what puts it in the target's needs-action feed. A spec naming a specific
  // pubkey addresses that person; `any` addresses the owner, because somebody
  // has to be told a run is waiting.
  const approver = /^[0-9a-f]{64}$/i.test(action.from)
    ? action.from.toLowerCase()
    : args.workflow.ownerPubkey;
  await emitLifecycle(
    ctx,
    args.scope,
    args.workflow,
    KIND_WORKFLOW_APPROVAL_REQUESTED,
    [
      [APPROVAL_TAG, tokenHash],
      ["workflow", args.workflow.workflowId],
      ["e", args.run.runId],
      ["p", approver],
      ["expiration", String(expiresAt)],
    ],
    action.message,
  );

  return { kind: "waiting" };
}

/**
 * Templates, applied to every field of an action that takes one.
 *
 * §1.9 names the two exceptions and this is where they are honoured: `method`
 * and `delay.duration` are copied through untouched.
 */
function resolveActionTemplates(
  action: ActionDef,
  trigger: TriggerContext,
  outputs: StepOutputs,
): ActionDef {
  const t = (text: string) => resolveTemplate(text, trigger, outputs);
  switch (action.action) {
    case "send_message":
      return {
        ...action,
        text: t(action.text),
        ...(action.channel === undefined ? {} : { channel: t(action.channel) }),
      };
    case "send_dm":
      return { ...action, to: t(action.to), text: t(action.text) };
    case "set_channel_topic":
      return { ...action, topic: t(action.topic) };
    case "add_reaction":
      return { ...action, emoji: t(action.emoji) };
    case "call_webhook": {
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(action.headers)) headers[name] = t(value);
      return {
        ...action,
        url: t(action.url),
        headers,
        ...(action.body === undefined ? {} : { body: t(action.body) }),
      };
    }
    case "request_approval":
      return { ...action, from: t(action.from), message: t(action.message) };
    case "delay":
      return action;
  }
}

// ---------------------------------------------------------------------------
// Deferred continuations
// ---------------------------------------------------------------------------

/**
 * Function references to this module's own internal functions.
 *
 * Through `anyApi` rather than `internal.buzz.workflows`, for the reason
 * `convex/crons.ts` and `convex/buzz/keys.ts` state: the checked-in
 * `_generated/api.d.ts` is a hand-rolled stub that predates `convex/buzz/`, so
 * the typed path does not exist until `npx convex dev` regenerates it. The
 * runtime path is identical (`internal` *is* `anyApi`). Replace with
 * `internal.buzz.workflows.*` the first time the CLI regenerates the stub.
 */
const selfRef = anyApi.buzz.workflows as unknown as {
  resumeDeferred: FunctionReference<
    "mutation",
    "internal",
    {
      scopeType: "user" | "workspace";
      scopeId: string;
      runId: string;
      stepIndex: number;
      output: Record<string, unknown>;
      error?: string;
    },
    null
  >;
  callWebhook: FunctionReference<
    "action",
    "internal",
    {
      scopeType: "user" | "workspace";
      scopeId: string;
      runId: string;
      stepIndex: number;
      url: string;
      method: string;
      headers: Record<string, string>;
      body: string;
      timeoutSecs: number;
    },
    null
  >;
};

/**
 * A deferred step has finished: record it and carry on.
 *
 * Guarded on `status === "running"` and on the step index, so a duplicate
 * delivery (a retried scheduler job, a webhook action that ran twice) cannot
 * append a second trace entry or advance the run twice. Idempotence by
 * construction rather than by a lock, which is the only kind that survives a
 * process that is no longer there.
 */
export const resumeDeferred = internalMutation({
  args: {
    ...scopeArgs,
    runId: v.string(),
    stepIndex: v.number(),
    output: v.any(),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const run = await runRow(ctx, scope, args.runId);
    if (!run) return null;
    if (run.status !== "running") return null;
    if (run.currentStep !== args.stepIndex) return null;

    const workflow = await workflowRow(ctx, scope, run.workflowId);
    const def = workflow ? definitionOf(workflow) : null;
    const stepId = def?.steps[args.stepIndex]?.id ?? "";
    const now = Date.now();
    const trace = [...((run.executionTrace ?? []) as TraceEntry[])];

    if (args.error !== undefined) {
      trace.push({
        stepId,
        status: "failed",
        output: {},
        startedAt: null,
        completedAt: now,
        error: args.error,
      });
      await writer(ctx).patch(run._id, {
        status: "failed",
        executionTrace: trace,
        completedAt: now,
        errorMessage: args.error,
      });
      if (workflow) {
        await emitLifecycle(
          ctx,
          scope,
          workflow,
          KIND_WORKFLOW_FAILED,
          [["d", run.runId], ["workflow", workflow.workflowId], ["p", workflow.ownerPubkey]],
          JSON.stringify({ error: args.error }),
        );
      }
      return null;
    }

    trace.push({
      stepId,
      status: "completed",
      output: (args.output ?? {}) as Record<string, unknown>,
      startedAt: null,
      completedAt: now,
      error: null,
    });
    await writer(ctx).patch(run._id, { executionTrace: trace, currentStep: args.stepIndex + 1 });
    const refreshed = await runRow(ctx, scope, args.runId);
    if (refreshed) await advanceRun(ctx, refreshed, args.stepIndex + 1);
    return null;
  },
});

/**
 * The one place this engine reaches the network.
 *
 * **What guards it, and what does not.** `webhookDestinationRefusal` is the
 * syntactic half of the app's SSRF rule: https only, no credentials in the URL,
 * no private host names, no private or IPv6 address literals. The other half —
 * resolving the hostname, checking *every* resolved address, and pinning the
 * first validated one into the request to defeat DNS rebinding — is what
 * `convex/_webhookNetwork.ts` does, and it cannot be reached from here: that
 * module is `"use node"` and this action runs in the default V8 runtime, which
 * has no DNS resolver to call. Stating the gap rather than implying it is
 * covered: a hostname that resolves to a private address will be reached.
 *
 * What compensates is §1.8, and it is why `call_webhook` is the one action
 * behind an elevated-authority gate: only a channel owner or admin can author
 * one, and the gate is re-checked at every fire, so the capability is bounded to
 * principals who could already move the room's content by hand.
 *
 * `redirect: "manual"` is not optional decoration — a redirect to an internal
 * host is the oldest way around a destination check.
 */
export const callWebhook = internalAction({
  args: {
    ...scopeArgs,
    runId: v.string(),
    stepIndex: v.number(),
    url: v.string(),
    method: v.string(),
    headers: v.any(),
    body: v.string(),
    timeoutSecs: v.number(),
  },
  handler: async (ctx: ActionCtx, args) => {
    const finish = (output: Record<string, unknown>, error?: string) =>
      ctx.runMutation(selfRef.resumeDeferred, {
        scopeType: args.scopeType,
        scopeId: args.scopeId,
        runId: args.runId,
        stepIndex: args.stepIndex,
        output,
        ...(error === undefined ? {} : { error }),
      });

    const refusal = webhookDestinationRefusal(args.url);
    if (refusal) {
      await finish({}, refusal);
      return null;
    }

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      Math.max(1, Math.min(args.timeoutSecs, WEBHOOK_TIMEOUT_SECS)) * 1000,
    );
    try {
      const headers = (args.headers ?? {}) as Record<string, string>;
      const method = args.method.toUpperCase();
      const response = await fetch(args.url, {
        method,
        headers: { "content-type": "application/json", ...headers },
        ...(method === "GET" || method === "HEAD" ? {} : { body: args.body }),
        redirect: "manual",
        signal: controller.signal,
      });
      const text = await response.text();
      await finish({
        status: response.status,
        // Truncated rather than refused: a response body is somebody else's
        // output, and a 2 MB page is not a reason to fail a step that otherwise
        // worked. The cap is what stops one from becoming a run row nobody can
        // load.
        body: text.slice(0, WEBHOOK_MAX_RESPONSE_BYTES),
      });
    } catch (err) {
      await finish({}, err instanceof Error ? err.message : "webhook call failed");
    } finally {
      clearTimeout(timer);
    }
    return null;
  },
});

// ---------------------------------------------------------------------------
// Creating a run (the shared half of all four doors)
// ---------------------------------------------------------------------------

async function activeRunCount(ctx: MutationCtx, scope: Scope): Promise<number> {
  let total = 0;
  for (const status of ["pending", "running"] as const) {
    const rows = await reader(ctx)
      .query("buzzWorkflowRuns")
      .withIndex("by_scope_status", (q) =>
        q.eq("scopeType", scope.scopeType).eq("scopeId", scope.scopeId).eq("status", status),
      )
      .take(MAX_CONCURRENT_RUNS + 1);
    total += rows.length;
    if (total > MAX_CONCURRENT_RUNS) return total;
  }
  return total;
}

/**
 * Create a run and execute it. Every door ends here.
 *
 * The authority re-check happens in the callers, *before* this — deliberately,
 * because the scheduled door has to check before it burns its at-most-once claim
 * (§1.10) and a check inside would be too late.
 */
async function startRun(
  ctx: MutationCtx,
  scope: Scope,
  workflow: WorkflowRow,
  def: WorkflowDef,
  trigger: TriggerContext,
  triggerEventId?: string,
): Promise<{ runId: string } | null> {
  const seq = workflow.runSeq + 1;
  await writer(ctx).patch(workflow._id, { runSeq: seq });
  const runId = communityNonce(scope, `workflow-run:${workflow.workflowId}:${seq}`).slice(0, 32);
  const now = Date.now();

  const runDocId = await writer(ctx).insert("buzzWorkflowRuns", {
    scopeType: scope.scopeType,
    scopeId: scope.scopeId,
    runId,
    workflowId: workflow.workflowId,
    status: "pending",
    ...(triggerEventId === undefined ? {} : { triggerEventId }),
    currentStep: 0,
    executionTrace: [],
    triggerContext: trigger,
    startedAt: now,
    createdAt: now,
  });

  await emitLifecycle(
    ctx,
    scope,
    workflow,
    KIND_WORKFLOW_TRIGGERED,
    [
      ["d", runId],
      ["workflow", workflow.workflowId],
      ...(triggerEventId ? [["e", triggerEventId]] : []),
      ["p", workflow.ownerPubkey],
    ],
    "{}",
  );

  // §1.9 step 1: the permit. No queuing — exhaustion is `CapacityExceeded`
  // immediately, and the run is finalized as failed so the refusal is visible in
  // the run history rather than being a message nobody sees.
  if ((await activeRunCount(ctx, scope)) > MAX_CONCURRENT_RUNS) {
    const row = await reader(ctx).get(runDocId);
    if (row) {
      await finishRun(ctx, scope, workflow, row, "failed", "workflow capacity exceeded");
    }
    return { runId };
  }

  await writer(ctx).patch(runDocId, { status: "running" });
  const row = await reader(ctx).get(runDocId);
  if (row) await advanceRun(ctx, row, 0);
  return { runId };
}

// ---------------------------------------------------------------------------
// Door 1 — an ingested event (§1.10)
// ---------------------------------------------------------------------------

type LogEvent = {
  id: string;
  pubkey: string;
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
};

/**
 * §1.5/§1.6's `build_trigger_context`.
 *
 * The `message_id` rule is NIP-25's: for a reaction the target is the **last**
 * `e` tag that is 64 hex characters, falling back to the reaction's own id. The
 * "last" is not a detail — a reaction may carry the thread root as an earlier
 * `e`, and reacting to the root instead of the message is a visible bug.
 */
export function triggerContextFromEvent(event: LogEvent, channelId: string): TriggerContext {
  const actorTag = event.tags.find((t) => t[0] === "actor")?.[1];
  const eTargets = event.tags
    .filter((t) => t[0] === "e" && typeof t[1] === "string" && /^[0-9a-f]{64}$/.test(t[1]))
    .map((t) => t[1]);
  return {
    text: event.content,
    author: actorTag || event.pubkey,
    channelId,
    timestamp: event.created_at,
    emoji: event.kind === KIND_REACTION ? event.content : "",
    messageId:
      event.kind === KIND_REACTION ? eTargets[eTargets.length - 1] ?? event.id : event.id,
    webhookFields: {},
  };
}

/** §1.10: kinds map strictly. `message_posted` is kind 9 and nothing else. */
export function triggerMatchesEvent(def: WorkflowDef, kind: number): boolean {
  switch (def.trigger.on) {
    case "message_posted":
      return kind === KIND_STREAM_MESSAGE;
    case "reaction_added":
      return kind === KIND_REACTION;
    case "diff_posted":
      return kind === KIND_STREAM_MESSAGE_DIFF;
    // Neither ever matches an ingested event. Stated rather than defaulted: the
    // day somebody adds a sixth trigger, this switch is where they have to
    // decide, instead of it silently matching everything or nothing.
    case "schedule":
    case "webhook":
      return false;
  }
}

/**
 * §1.10: the emoji and filter conditions, evaluated **after** kind matching.
 *
 * A filter that errors skips the workflow — fail closed. See
 * `workflow-expr.filterAllows` for why that is the opposite of what an `if:`
 * does.
 */
export function shouldFire(def: WorkflowDef, trigger: TriggerContext): boolean {
  if (def.trigger.on === "reaction_added") {
    if (def.trigger.emoji !== undefined && def.trigger.emoji !== "") {
      return def.trigger.emoji === trigger.emoji;
    }
    return true;
  }
  const filter =
    def.trigger.on === "message_posted" || def.trigger.on === "diff_posted"
      ? def.trigger.filter
      : undefined;
  if (filter === undefined || filter.trim() === "") return true;
  return filterAllows(filter, buildEvalContext(trigger));
}

/**
 * The post-store hook: an event landed, does any workflow answer it?
 *
 * **Where this docks.** One line at the end of `messages.postMessageCore` —
 * `await onEventCore(ctx, scope, event, channelId)` — added in the same edit
 * that spreads `buzzWorkflowTables` into `convex/schema.ts`. It is not there yet
 * for the reason `moderation.requireNotRestricted`'s call site is not either: a
 * module that queries a table the schema does not declare fails at its first
 * read, and `messages.ts` is imported by most of the Chat suite. Until then
 * `dispatchEvent` below is the door, and it is what the tests drive.
 *
 * It is deliberately **not** called from `publishCore`. `log.ts` is the only
 * module allowed to write the table and it must stay loadable on its own; a call
 * out of the log into an engine that posts messages (which publishes, which
 * would call back) is a cycle at runtime as well as in the import graph.
 */
export async function onEventCore(
  ctx: MutationCtx,
  scope: Scope,
  event: LogEvent,
  channelId: string | undefined,
): Promise<{ fired: string[] }> {
  const fired: string[] = [];
  if (!channelId) return { fired };
  if (isWorkflowExecutionKind(event.kind)) return { fired };
  // The second half of loop prevention: a workflow does not answer its own
  // output. Without it, a `message_posted` workflow that posts a message is an
  // infinite loop bounded only by the capacity semaphore.
  if (event.tags.some((t) => t[0] === WORKFLOW_TAG)) return { fired };

  const rows = await reader(ctx)
    .query("buzzWorkflows")
    .withIndex("by_scope_channel", (q) =>
      q.eq("scopeType", scope.scopeType).eq("scopeId", scope.scopeId).eq("channelId", channelId),
    )
    .collect();

  const trigger = triggerContextFromEvent(event, channelId);
  for (const workflow of rows) {
    if (!workflow.enabled || workflow.status !== "active") continue;
    const def = definitionOf(workflow);
    if (!def || !def.enabled) continue;
    if (!triggerMatchesEvent(def, event.kind)) continue;
    if (!shouldFire(def, trigger)) continue;
    if (!(await ownerAuthorityAllows(ctx, scope, workflow, def))) continue;
    // Already fired for this event? Then this is a second delivery, not a
    // second event. Same at-most-once rule the scheduled door enforces with a
    // claim row, answered here from the run that recorded the first fire.
    const already = await reader(ctx)
      .query("buzzWorkflowRuns")
      .withIndex("by_trigger_event", (q) =>
        q
          .eq("scopeType", scope.scopeType)
          .eq("scopeId", scope.scopeId)
          .eq("workflowId", workflow.workflowId)
          .eq("triggerEventId", event.id),
      )
      .first();
    if (already) continue;
    const started = await startRun(ctx, scope, workflow, def, trigger, event.id);
    if (started) fired.push(started.runId);
  }
  return { fired };
}

/** The internal door, so the hook can equally be a scheduler call. */
export const dispatchEvent = internalMutation({
  args: { ...scopeArgs, eventId: v.string() },
  handler: async (ctx, args) => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const row = await ctx.db
      .query("buzzEvents")
      .withIndex("by_scope_event_id", (q) =>
        q
          .eq("scopeType", scope.scopeType)
          .eq("scopeId", scope.scopeId)
          .eq("eventId", args.eventId),
      )
      .first();
    if (!row) return { fired: [] };
    return await onEventCore(
      ctx,
      scope,
      {
        id: row.eventId,
        pubkey: row.pubkey,
        kind: row.kind,
        created_at: row.createdAt,
        tags: row.tags,
        content: row.content,
      },
      row.channelId,
    );
  },
});

// ---------------------------------------------------------------------------
// Door 2 — the schedule (§1.10)
// ---------------------------------------------------------------------------

/**
 * One tick of the scheduler.
 *
 * Registered in `convex/crons.ts` by the integrator (one `crons.interval` entry
 * calling `anyApi.buzz.workflows.tickScheduled`, alongside the reminders one) —
 * that file is edited by every concurrent Chat phase, so the registration is a
 * line the integrator applies rather than a merge conflict this phase creates.
 * `windowSecs` must match the cron cadence: it is the tolerance for tick drift,
 * and a window narrower than the gap between ticks silently drops fires.
 *
 * The order below is §1.10's and each step is there for a reason: the authority
 * check runs **before** the durable claim, so an owner who has lost their role
 * cannot burn the at-most-once slot for a fire that will never happen.
 */
export async function tickScheduledCore(
  ctx: MutationCtx,
  scope: Scope,
  windowSecs: number,
  nowSecs: number,
): Promise<{ fired: string[] }> {
  {

    const rows = await reader(ctx)
      .query("buzzWorkflows")
      .withIndex("by_scope_enabled", (q) =>
        q.eq("scopeType", scope.scopeType).eq("scopeId", scope.scopeId).eq("enabled", true),
      )
      .collect();

    const fired: string[] = [];
    for (const workflow of rows) {
      if (workflow.status !== "active" || workflow.channelId === "") continue;
      const def = definitionOf(workflow);
      if (!def || !def.enabled || def.trigger.on !== "schedule") continue;

      let scheduledFor: number | null = null;
      if (def.trigger.cron) {
        scheduledFor = cronFireInstant(def.trigger.cron, nowSecs, windowSecs);
      } else if (def.trigger.interval) {
        const secs = parseDurationSecs(def.trigger.interval);
        if (secs !== null && secs > 0) scheduledFor = intervalFireInstant(secs, nowSecs);
      }
      if (scheduledFor === null) continue;

      if (!(await ownerAuthorityAllows(ctx, scope, workflow, def))) continue;

      const claimed = await claimScheduledFire(ctx, scope, workflow.workflowId, scheduledFor);
      if (!claimed) continue;

      const trigger = emptyTriggerContext({
        channelId: workflow.channelId,
        timestamp: scheduledFor,
        author: workflow.ownerPubkey,
      });
      const started = await startRun(ctx, scope, workflow, def, trigger);
      if (started) {
        fired.push(started.runId);
        await writer(ctx).patch(claimed, { runId: started.runId });
      }
    }
    return { fired };
  }
}

/** One community's scheduled fires. Kept for tests and manual invocation. */
export const tickScheduled = internalMutation({
  args: { ...scopeArgs, windowSecs: v.optional(v.number()), nowSecs: v.optional(v.number()) },
  handler: async (ctx, args) =>
    await tickScheduledCore(
      ctx,
      { scopeType: args.scopeType, scopeId: args.scopeId },
      args.windowSecs ?? 900,
      args.nowSecs ?? Math.floor(Date.now() / 1000),
    ),
});

/**
 * Every community's scheduled fires — what the cron actually calls.
 *
 * A cron has fixed arguments, so `tickScheduled` alone could only ever reach
 * one community. It needs a list of them, and it cannot get one from the
 * workflow table: every index there leads with the scope, which is the tenancy
 * fence and not negotiable. So the communities are enumerated from the rows
 * that define them — workspaces, plus each user's personal space.
 *
 * That is O(communities) transactions per tick rather than O(due workflows),
 * which is the honest trade at our scale and the wrong one at a much larger
 * one. The fix, when it is needed, is the pattern `buzz/reminders.ts` already
 * uses for exactly this problem: a small projection row per scheduled fire,
 * keyed by when it is due, so "everything due now, anywhere" has an index to
 * range. Written down here rather than discovered later.
 */
/**
 * How many communities one scheduled sweep will visit.
 *
 * Not a tuning knob so much as the point at which this design should be
 * replaced: past it, schedules need the due-time projection `reminders.ts`
 * already uses, where "everything due now, anywhere" is one index range instead
 * of a walk over every community.
 */
const SWEEP_LIMIT = 200;

export const tickAllScheduled = internalMutation({
  args: { windowSecs: v.optional(v.number()), nowSecs: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const windowSecs = args.windowSecs ?? 900;
    const nowSecs = args.nowSecs ?? Math.floor(Date.now() / 1000);
    const fired: string[] = [];

    // Bounded, and it says so when it truncates.
    //
    // `.collect()` over every workspace and every user is fine on a small
    // deployment and throws on a large one — Convex caps documents read in a
    // transaction, so an unbounded sweep degrades from "slow" straight to "this
    // cron fails every fifteen minutes". A cap turns that into a bounded pass
    // that still fires most schedules, and the log line is the house rule
    // against silent truncation: a sweep that quietly covers the first N reads
    // as though it covered everything.
    const workspaces = await ctx.db.query("workspaces").take(SWEEP_LIMIT + 1);
    const users = await ctx.db.query("users").take(SWEEP_LIMIT + 1);
    if (workspaces.length > SWEEP_LIMIT || users.length > SWEEP_LIMIT) {
      console.warn(
        `buzz/workflows.tickAllScheduled: more than ${SWEEP_LIMIT} communities; ` +
          `this pass covered the first ${SWEEP_LIMIT}. Move to a due-time ` +
          `projection row (see buzz/reminders.ts) before relying on schedules here.`,
      );
    }

    for (const workspace of workspaces.slice(0, SWEEP_LIMIT)) {
      const result = await tickScheduledCore(
        ctx,
        { scopeType: "workspace", scopeId: workspace._id },
        windowSecs,
        nowSecs,
      );
      fired.push(...result.fired);
    }
    for (const user of users.slice(0, SWEEP_LIMIT)) {
      const result = await tickScheduledCore(
        ctx,
        { scopeType: "user", scopeId: user.clerkId },
        windowSecs,
        nowSecs,
      );
      fired.push(...result.fired);
    }
    return { fired };
  },
});

/**
 * The cross-pod at-most-once boundary (§1.10), which on this substrate is one
 * read and one insert inside a serializable transaction.
 *
 * Returns the claim row, or null when somebody already holds it. If the claim
 * wins and the run then fails to start, the row **stays** — at-most-once beats
 * exactly-once, because a schedule that fires twice posts twice.
 */
async function claimScheduledFire(
  ctx: MutationCtx,
  scope: Scope,
  workflowId: string,
  scheduledFor: number,
): Promise<GenericId<"buzzWorkflowFires"> | null> {
  const existing = await reader(ctx)
    .query("buzzWorkflowFires")
    .withIndex("by_claim", (q) =>
      q
        .eq("scopeType", scope.scopeType)
        .eq("scopeId", scope.scopeId)
        .eq("workflowId", workflowId)
        .eq("scheduledFor", scheduledFor),
    )
    .unique();
  if (existing) return null;
  return (await writer(ctx).insert("buzzWorkflowFires", {
    scopeType: scope.scopeType,
    scopeId: scope.scopeId,
    workflowId,
    scheduledFor,
    createdAt: Date.now(),
  })) as GenericId<"buzzWorkflowFires">;
}

// ---------------------------------------------------------------------------
// Door 3 — the manual trigger, kind 46020 (§1.10)
// ---------------------------------------------------------------------------

/**
 * "Run this workflow now."
 *
 * §1.10: **only the owner** may trigger, and the workflow must be enabled and
 * active. Note what the owner check is *not* — it is not "may this person see
 * the room". A member who can read a workflow definition can read the bearer
 * tokens somebody wrote into its `headers:`, but they may not make it run, and
 * those are different permissions on purpose.
 */
export const trigger = mutation({
  args: { ...scopeArgs, workflowId: v.string(), inputs: v.optional(v.any()) },
  handler: async (ctx, args) => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const workflow = await requireOwnedWorkflow(ctx, scope, args.workflowId);
    if (!workflow.enabled || workflow.status !== "active") {
      refuse(workflowError("Unauthorized", "this workflow is not active"));
    }
    const def = definitionOf(workflow);
    if (!def) refuse(workflowError("InvalidDefinition", "workflow definition does not parse"));
    if (!def.enabled) refuse(workflowError("Unauthorized", "this workflow is not enabled"));
    if (!(await ownerAuthorityAllows(ctx, scope, workflow, def))) {
      refuse(workflowError("Unauthorized", "the workflow owner no longer has that authority"));
    }
    const started = await startRun(
      ctx,
      scope,
      workflow,
      def,
      emptyTriggerContext({
        channelId: workflow.channelId,
        author: workflow.ownerPubkey,
        timestamp: Math.floor(Date.now() / 1000),
        webhookFields: flattenBody(args.inputs),
      }),
    );
    return { runId: started?.runId ?? null };
  },
});

/**
 * §1.10: a JSON object body becomes `webhook_fields`; non-string values are
 * stringified. Anything that is not an object contributes nothing — a JSON
 * array has no field names to bind, and inventing `0`, `1`, `2` would produce
 * variables no author could have written.
 */
export function flattenBody(body: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof body !== "object" || body === null || Array.isArray(body)) return out;
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (typeof value === "string") out[key] = value;
    else if (value === null || value === undefined) out[key] = "";
    else if (typeof value === "number" || typeof value === "boolean") out[key] = String(value);
    else out[key] = JSON.stringify(value) ?? "";
  }
  return out;
}

// ---------------------------------------------------------------------------
// Door 4 — the webhook (§1.10)
// ---------------------------------------------------------------------------

export type WebhookFireResult =
  | { status: "not_found" }
  | { status: "accepted"; runId: string; workflowId: string };

/**
 * `POST /hooks/{workflow-id}`, as the mutation the route calls.
 *
 * **Everything fails closed with the same `not_found`** (§1.8): a workflow that
 * is not in this community, a disabled one, one whose trigger is not `webhook`,
 * a bad secret, an owner who has lost authority. They are indistinguishable on
 * purpose — a caller must not be able to probe which workflow ids exist, and a
 * distinguishable "wrong secret" is an oracle for exactly that.
 *
 * An `internalMutation` rather than a public one: the credential is the secret
 * in the header, so the HTTP route (a later phase owns `convex/http.ts`) is the
 * only thing that should be able to present it, and an internal function cannot
 * be called from a browser at all.
 */
export const fireWebhook = internalMutation({
  args: { ...scopeArgs, workflowId: v.string(), secret: v.string(), body: v.optional(v.any()) },
  handler: async (ctx, args): Promise<WebhookFireResult> => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const workflow = await workflowRow(ctx, scope, args.workflowId);
    if (!workflow) return { status: "not_found" };
    if (!workflow.enabled || workflow.status !== "active") return { status: "not_found" };
    if (workflow.channelId === "") return { status: "not_found" };

    const def = definitionOf(workflow);
    if (!def || !def.enabled || def.trigger.on !== "webhook") return { status: "not_found" };

    const stored = (workflow.definition as Record<string, unknown> | null)?.[WEBHOOK_SECRET_KEY];
    if (typeof stored !== "string" || !constantTimeEquals(stored, args.secret)) {
      return { status: "not_found" };
    }
    if (!(await ownerAuthorityAllows(ctx, scope, workflow, def))) return { status: "not_found" };

    const started = await startRun(
      ctx,
      scope,
      workflow,
      def,
      emptyTriggerContext({
        channelId: workflow.channelId,
        author: workflow.ownerPubkey,
        timestamp: Math.floor(Date.now() / 1000),
        webhookFields: flattenBody(args.body),
      }),
    );
    if (!started) return { status: "not_found" };
    return { status: "accepted", runId: started.runId, workflowId: workflow.workflowId };
  },
});

// ---------------------------------------------------------------------------
// The approval gate (§1.11)
// ---------------------------------------------------------------------------

/**
 * §1.11's `check_approver_spec`, fail-closed.
 *
 * `""` or `"any"` means anyone who can reach the room; a 64-hex pubkey means
 * that person, compared case-insensitively. **Anything else is refused**,
 * including role strings like `@release-manager` — Buzz refuses them because it
 * has no role resolver, and we refuse them because accepting an unrecognised
 * spec as "anyone" is a gate that silently opens.
 */
export function approverSpecAllows(spec: string, callerPubkey: string): boolean {
  const trimmed = spec.trim();
  if (trimmed === "" || trimmed.toLowerCase() === "any") return true;
  if (/^[0-9a-f]{64}$/i.test(trimmed)) {
    return trimmed.toLowerCase() === callerPubkey.toLowerCase();
  }
  return false;
}

async function resolveApproval(
  ctx: MutationCtx,
  scope: Scope,
  tokenHash: string,
): Promise<{ approval: ApprovalRow; workflow: WorkflowRow; run: RunRow; callerPubkey: string }> {
  const approval = await reader(ctx)
    .query("buzzWorkflowApprovals")
    .withIndex("by_scope_token", (q) =>
      q.eq("scopeType", scope.scopeType).eq("scopeId", scope.scopeId).eq("tokenHash", tokenHash),
    )
    .unique();
  if (!approval) throw new ConvexError("Approval not found");

  const workflow = await workflowRow(ctx, scope, approval.workflowId);
  if (!workflow) throw new ConvexError("Approval not found");
  // The room fence: an approval is only actionable by somebody who can reach the
  // room the workflow runs in. `requireChannelAccess` is the tenancy fence too.
  const { subject } = await requireChannelAccess(ctx, scope, workflow.channelId);
  const callerPubkey = (await pubkeyFor(ctx, "user", subject)) ?? "";

  const run = await runRow(ctx, scope, approval.runId);
  if (!run) throw new ConvexError("Approval not found");

  if (approval.status !== "pending") throw new ConvexError("That approval was already acted on");
  if (approval.expiresAt <= Math.floor(Date.now() / 1000)) {
    await writer(ctx).patch(approval._id, { status: "expired" });
    throw new ConvexError("That approval has expired");
  }
  if (!approverSpecAllows(approval.approverSpec, callerPubkey)) {
    refuse(
      workflowError(
        "Unauthorized",
        `approver spec ${approval.approverSpec} is not yet supported, or you are not the named approver`,
      ),
    );
  }
  return { approval, workflow, run, callerPubkey };
}

/**
 * Kind 46030: grant, then resume.
 *
 * The order matters and is §1.11's: the approval flips to `granted` and *then*
 * the run resumes, so a lost race yields "already acted on" rather than two
 * resumptions of the same run. On our substrate both halves are in one
 * transaction, which is strictly stronger than Buzz's commit-then-spawn.
 */
export const grantApproval = mutation({
  args: { ...scopeArgs, token: v.string(), note: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const { approval, workflow, run, callerPubkey } = await resolveApproval(ctx, scope, args.token);
    await writer(ctx).patch(approval._id, {
      status: "granted",
      approverPubkey: callerPubkey,
      ...(args.note === undefined ? {} : { note: args.note }),
    });
    await emitLifecycle(
      ctx,
      scope,
      workflow,
      KIND_WORKFLOW_APPROVAL_GRANTED,
      [[APPROVAL_TAG, approval.tokenHash], ["p", callerPubkey], ["e", run.runId]],
      args.note ?? "",
    );

    if (run.status !== "waiting_approval") return { resumed: false };

    // The suspended step's own output, which is what §1.14's approval fixture
    // branches on (`steps_request_output_approved == true`). Written now rather
    // than at suspension time, because until somebody acts there is no answer.
    const trace = ((run.executionTrace ?? []) as TraceEntry[]).map((entry) =>
      entry.stepId === approval.stepId && entry.status === "waiting_approval"
        ? {
            ...entry,
            status: "completed" as const,
            output: {
              approved: true,
              approver: callerPubkey,
              note: args.note ?? "",
            },
            completedAt: Date.now(),
          }
        : entry,
    );
    await writer(ctx).patch(run._id, {
      status: "running",
      executionTrace: trace,
      currentStep: approval.stepIndex + 1,
    });
    const refreshed = await runRow(ctx, scope, run.runId);
    if (refreshed) await advanceRun(ctx, refreshed, approval.stepIndex + 1);
    return { resumed: true };
  },
});

/**
 * Kind 46031: deny, and cancel the run.
 *
 * A denial **cancels** rather than continuing with `approved == false` — Buzz's
 * behaviour, kept, and it is the safer of the two: a workflow whose later steps
 * run after a human said no is a workflow whose gate was advisory. The
 * consequence is that §1.14's `notify_denied` branch is unreachable, which is a
 * fact about the fixture rather than about the engine.
 */
export const denyApproval = mutation({
  args: { ...scopeArgs, token: v.string(), note: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const { approval, workflow, run, callerPubkey } = await resolveApproval(ctx, scope, args.token);
    await writer(ctx).patch(approval._id, {
      status: "denied",
      approverPubkey: callerPubkey,
      ...(args.note === undefined ? {} : { note: args.note }),
    });
    await emitLifecycle(
      ctx,
      scope,
      workflow,
      KIND_WORKFLOW_APPROVAL_DENIED,
      [[APPROVAL_TAG, approval.tokenHash], ["p", callerPubkey], ["e", run.runId]],
      args.note ?? "",
    );
    await finishRun(
      ctx,
      scope,
      workflow,
      run,
      "cancelled",
      `workflow cancelled: approval denied by ${callerPubkey}`,
    );
    return { cancelled: true };
  },
});

// ---------------------------------------------------------------------------
// Exported for the tests and for whatever draws this later
// ---------------------------------------------------------------------------

export type { WorkflowView };

/** The table map the integrator spreads into `convex/schema.ts`. */
export type BuzzWorkflowTables = SchemaDefinition<typeof buzzWorkflowTables, true>["tables"];
