import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import {
  clearPresence,
  markPresence,
  readViewers as presenceViewers,
} from "./presence";
import { requirePageAccess, requireScopeAccess } from "./_authz";
import {
  canAccessSpace,
  getSpaceForList,
  requireIdentity,
  requireListAccess,
  requireProjectAccess,
  requireSpaceAccess,
  requireTaskAccess,
} from "./_authz";
import type { Actor } from "./_agentAuth";
import { emitEvent, userActor } from "./events";
import {
  inferTitle,
  linkTargets,
  markdownExcerpt,
  mentionContext,
  mentionedActorIds,
} from "./_markdown";
import { canBeMentioned } from "./messages";
import { notify } from "./notificationCenter";
import { enqueueAgentPingDelivery } from "./agentPingDeliveries";
import { scopeChannel } from "./realtime";

// Pages: the long-form layer.
//
// Everything here is built on three ideas the rest of the app already uses,
// so this is a feature rather than a second product:
//
//   - Markdown is the source of truth (see the schema comment). No lossy
//     round trip between an agent's representation and a human's.
//   - A page lives in exactly one scope and shows up in many places, via
//     pageAttachments. Copying context is how context goes stale.
//   - Authorization resolves through the existing _authz helpers. A page is
//     readable if its scope is; an attachment is only allowed if the caller
//     can already open the thing being attached to.

export type PageScope = { scopeType: "user" | "workspace"; scopeId: string };

const scopeValidator = v.union(v.literal("user"), v.literal("workspace"));

const targetTypeValidator = v.union(
  v.literal("workspace"),
  v.literal("space"),
  v.literal("project"),
  v.literal("list"),
  v.literal("task"),
  v.literal("agent"),
  v.literal("goal"),
  v.literal("sprint"),
);

type TargetType = (typeof targetTypeValidator)["type"];

// ── Access ──────────────────────────────────────────────────────────────

/**
 * Confirms the caller can open whatever a page is being attached to, and
 * returns the scope that thing lives in.
 *
 * Attachment is the one place a page touches the rest of the hierarchy, so
 * it is the one place that could leak: pinning a workspace page onto a task
 * in a private space would put it in front of people who can't open the
 * page's own scope. Both sides are checked, and the scopes must match.
 */
async function requireTargetAccess(
  ctx: QueryCtx | MutationCtx,
  targetType: TargetType,
  targetId: string,
): Promise<PageScope> {
  switch (targetType) {
    case "workspace": {
      await requireScopeAccess(ctx, {
        scopeType: "workspace",
        scopeId: targetId,
      });
      return { scopeType: "workspace", scopeId: targetId };
    }
    case "space": {
      const { space } = await requireSpaceAccess(ctx, targetId as Id<"spaces">);
      return { scopeType: space.parentType, scopeId: space.parentId };
    }
    case "project": {
      const { space } = await requireProjectAccess(
        ctx,
        targetId as Id<"projects">,
      );
      return { scopeType: space.parentType, scopeId: space.parentId };
    }
    case "list": {
      const { space } = await requireListAccess(ctx, targetId as Id<"lists">);
      return { scopeType: space.parentType, scopeId: space.parentId };
    }
    case "task": {
      const { space } = await requireTaskAccess(ctx, targetId as Id<"tasks">);
      return { scopeType: space.parentType, scopeId: space.parentId };
    }
    case "agent": {
      const agent = await ctx.db.get(targetId as Id<"agents">);
      if (!agent) throw new ConvexError("Agent not found");
      const scope: PageScope = {
        scopeType: agent.parentType,
        scopeId: agent.parentId,
      };
      await requireScopeAccess(ctx, scope);
      return scope;
    }
    case "goal": {
      const goal = await ctx.db.get(targetId as Id<"goals">);
      if (!goal) throw new ConvexError("Goal not found");
      const scope: PageScope = {
        scopeType: goal.parentType,
        scopeId: goal.parentId,
      };
      await requireScopeAccess(ctx, scope);
      return scope;
    }
    case "sprint": {
      const sprint = await ctx.db.get(targetId as Id<"sprints">);
      if (!sprint) throw new ConvexError("Sprint not found");
      const scope: PageScope = {
        scopeType: "workspace",
        scopeId: sprint.workspaceId,
      };
      await requireScopeAccess(ctx, scope);
      return scope;
    }
  }
}

// ── Link + index bookkeeping ────────────────────────────────────────────

/**
 * Rewrites this page's outgoing [[wikilinks]].
 *
 * Targets resolve by title within the same scope, case-insensitively. A link
 * to a page that doesn't exist yet stores nothing — the editor renders those
 * as "not created", the way a wiki should, rather than failing the save.
 */
async function syncLinks(
  ctx: MutationCtx,
  page: Doc<"pages">,
  markdown: string,
): Promise<void> {
  const wanted = linkTargets(markdown);

  const siblings = await ctx.db
    .query("pages")
    .withIndex("by_scope", (q) =>
      q.eq("scopeType", page.scopeType).eq("scopeId", page.scopeId),
    )
    .collect();
  const byTitle = new Map(siblings.map((p) => [p.title.toLowerCase(), p._id]));

  const resolved = new Set<string>();
  for (const target of wanted) {
    const id = byTitle.get(target);
    if (id && id !== page._id) resolved.add(id);
  }

  const existing = await ctx.db
    .query("pageLinks")
    .withIndex("by_from", (q) => q.eq("fromPageId", page._id))
    .collect();
  const had = new Set(existing.map((l) => l.toPageId as string));

  for (const link of existing) {
    if (!resolved.has(link.toPageId as string)) await ctx.db.delete(link._id);
  }
  for (const toPageId of resolved) {
    if (had.has(toPageId)) continue;
    await ctx.db.insert("pageLinks", {
      fromPageId: page._id,
      toPageId: toPageId as Id<"pages">,
    });
  }
}

/**
 * Keeps a page in the same vector index docs and tasks use, so Brain search
 * finds it without a second search system. Scheduled, never awaited: an
 * embedding call must not sit inside the write transaction.
 */
async function reindex(
  ctx: MutationCtx,
  page: Doc<"pages">,
  markdown: string,
): Promise<void> {
  await ctx.scheduler.runAfter(0, internal.ai.indexPage, {
    pageId: page._id,
    title: page.title,
    text: markdown,
    scopeType: page.scopeType,
    scopeId: page.scopeId,
  });
}

/** Nudges anyone watching this scope that a page changed. */
/**
 * Turn `@[Name](actorId)` tokens in a page's markdown into real mentions.
 *
 * A page is saved every few hundred milliseconds while someone types, so
 * this is idempotent by construction: it only inserts a row for a principal
 * who is not already mentioned on this page. Removing a mention does NOT
 * retract the notification — being told "you were tagged" and then having
 * that quietly vanish is worse than a stale row.
 */
async function syncMentions(
  ctx: MutationCtx,
  page: Doc<"pages">,
  markdown: string,
  actor: Actor,
): Promise<void> {
  const ids = mentionedActorIds(markdown).filter((id) => id !== actor.id);
  if (ids.length === 0) return;

  const existing = await ctx.db
    .query("mentions")
    .withIndex("by_parent", (q) =>
      q.eq("parentType", "page").eq("parentId", page._id),
    )
    .collect();
  // Only body mentions count for dedupe. A comment on this page produces a
  // mention row with the same parent, and letting that suppress a later
  // mention written into the page itself would silently drop a notification.
  const already = new Set(
    existing
      .filter((m) => m.messageId === undefined)
      .map((m) => m.mentionedClerkId),
  );

  const workspaceId =
    page.scopeType === "workspace" ? (page.scopeId as Id<"workspaces">) : null;
  const personalOwner = page.scopeType === "user" ? page.scopeId : null;

  for (const id of ids) {
    if (already.has(id)) continue;
    if (!(await canBeMentioned(ctx, id, workspaceId, personalOwner))) continue;

    const snippet = mentionContext(markdown, id);
    await ctx.db.insert("mentions", {
      mentionedClerkId: id,
      parentType: "page",
      parentId: page._id,
      snippet,
      byName: actor.name,
      createdAt: Date.now(),
    });

    await emitEvent(ctx, {
      scopeType: page.scopeType,
      scopeId: page.scopeId,
      type: "mention.created",
      actor,
      entityType: "page",
      entityId: page._id,
      entityTitle: page.title,
      payload: { mentionedId: id, snippet, parentType: "page" },
    });

    // Mentioned agents get pushed at directly; mentioned people get an
    // inbox row. Same two channels a comment mention uses.
    const agentId = ctx.db.normalizeId("agents", id);
    if (agentId) {
      const agent = await ctx.db.get(agentId);
      if (agent) {
        await enqueueAgentPingDelivery(ctx, {
          scopeType: page.scopeType,
          scopeId: page.scopeId,
          workspaceId: workspaceId ?? undefined,
          sourceKind: "mention",
          sourceId: page._id,
          agentId,
          push: agent.notifyUrl !== undefined,
          type: "mention.created",
          payload: {
            parentType: "page",
            parentId: page._id,
            pageTitle: page.title,
            snippet,
            byName: actor.name,
          },
        });
      }
      continue;
    }

    const recipient = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", id))
      .unique();
    if (recipient?.email) {
      await notify(ctx, {
        userClerkId: id,
        type: "mention",
        title: `${actor.name} mentioned you in ${page.title}`,
        body: snippet,
        href: `/dashboard/pages/${page._id}`,
      });
    }
  }
}

/** Mentions die with the page — nothing to click through to any more. */
async function removeMentions(
  ctx: MutationCtx,
  pageId: Id<"pages">,
): Promise<void> {
  for (const m of await ctx.db
    .query("mentions")
    .withIndex("by_parent", (q) =>
      q.eq("parentType", "page").eq("parentId", pageId),
    )
    .collect()) {
    await ctx.db.delete(m._id);
  }
}

// ── History ─────────────────────────────────────────────────────────────

/**
 * How long one author's edits collapse into a single revision.
 *
 * A page saves every ~700ms while someone types. Snapshotting each write would
 * produce hundreds of rows for one paragraph and a history nobody can read, so
 * a revision stays open for this long and is extended in place while the same
 * author keeps editing. A different author always opens a new one — "who
 * changed this" is the question history exists to answer, and merging two
 * people's edits into one row destroys it.
 */
const REVISION_WINDOW_MS = 5 * 60 * 1000;

/** How many revisions a page keeps. Older ones are pruned on write. */
const REVISION_LIMIT = 50;

/**
 * Record what the page said *before* this edit.
 *
 * Called with the pre-edit content, so revision N is what you get back if you
 * restore it — the alternative (snapshotting the new state) means the newest
 * revision is always identical to the live page and restoring it does nothing.
 */
async function recordRevision(
  ctx: MutationCtx,
  page: Doc<"pages">,
  actor: Actor,
): Promise<void> {
  const now = Date.now();
  const recent = await ctx.db
    .query("pageRevisions")
    .withIndex("by_page_and_time", (q) => q.eq("pageId", page._id))
    .order("desc")
    .take(1);
  const open = recent[0];

  if (
    open &&
    open.actorId === actor.id &&
    now - open.updatedAt < REVISION_WINDOW_MS
  ) {
    // Same author, still inside the window: the open revision already holds
    // the "before" state from the start of this editing session, which is
    // exactly what should be preserved. Only extend it.
    await ctx.db.patch(open._id, { updatedAt: now });
    return;
  }

  await ctx.db.insert("pageRevisions", {
    pageId: page._id,
    title: page.title,
    markdown: page.markdown,
    actorId: actor.id,
    actorName: actor.name,
    createdAt: now,
    updatedAt: now,
  });

  // Prune past the cap. Bounded work per write: at most one row falls off.
  const all = await ctx.db
    .query("pageRevisions")
    .withIndex("by_page_and_time", (q) => q.eq("pageId", page._id))
    .order("desc")
    .collect();
  for (const old of all.slice(REVISION_LIMIT)) {
    await ctx.db.delete(old._id);
  }
}

async function publishChange(
  ctx: MutationCtx,
  page: Doc<"pages">,
  type: string,
): Promise<void> {
  await ctx.scheduler.runAfter(0, internal.realtime.publish, {
    channel: scopeChannel(page.scopeType, page.scopeId),
    name: type,
    data: { pageId: page._id, title: page.title },
  });
}

// ── Cores (shared with agentApi) ────────────────────────────────────────

export async function createPageCore(
  ctx: MutationCtx,
  scope: PageScope,
  args: {
    title?: string;
    markdown?: string;
    parentPageId?: Id<"pages">;
  },
  actor: Actor,
): Promise<Id<"pages">> {
  const markdown = args.markdown ?? "";
  const title = (args.title?.trim() || inferTitle(markdown)).slice(0, 200);

  const siblings = await ctx.db
    .query("pages")
    .withIndex("by_scope", (q) =>
      q.eq("scopeType", scope.scopeType).eq("scopeId", scope.scopeId),
    )
    .collect();
  const position = siblings.reduce((max, p) => Math.max(max, p.position + 1), 0);

  const now = Date.now();
  const pageId = await ctx.db.insert("pages", {
    title,
    markdown,
    scopeType: scope.scopeType,
    scopeId: scope.scopeId,
    parentPageId: args.parentPageId,
    position,
    createdByActorId: actor.id,
    createdByName: actor.name,
    createdAt: now,
    updatedAt: now,
  });

  const page = (await ctx.db.get(pageId))!;
  await syncLinks(ctx, page, markdown);
  await syncMentions(ctx, page, markdown, actor);
  if (markdown.trim()) await reindex(ctx, page, markdown);
  await publishChange(ctx, page, "page.created");
  return pageId;
}

/**
 * Refuses a move that would make a page its own ancestor.
 *
 * Without this a two-click mistake ("put A under B", "put B under A")
 * detaches a whole subtree from every root and makes it unreachable — the
 * index only ever walks down.
 */
async function assertNoCycle(
  ctx: MutationCtx,
  pageId: Id<"pages">,
  parentId: Id<"pages">,
): Promise<void> {
  let cursor: Id<"pages"> | undefined = parentId;
  // Bounded so a pre-existing cycle can't spin here forever.
  for (let hops = 0; cursor && hops < 64; hops += 1) {
    if (cursor === pageId) {
      throw new ConvexError("A page can't be nested inside itself");
    }
    const node: Doc<"pages"> | null = await ctx.db.get(cursor);
    cursor = node?.parentPageId;
  }
}

export async function updatePageCore(
  ctx: MutationCtx,
  page: Doc<"pages">,
  args: {
    title?: string;
    markdown?: string;
    /** null moves the page to the top level; undefined leaves it alone. */
    parentPageId?: Id<"pages"> | null;
    /**
     * The `updatedAt` the caller's copy was based on. When it no longer
     * matches, someone else has written since — refuse rather than
     * overwrite. Optional so agents and one-shot edits opt in.
     */
    expectedUpdatedAt?: number;
  },
  actor: Actor,
): Promise<{ updatedAt: number }> {
  if (
    args.expectedUpdatedAt !== undefined &&
    args.expectedUpdatedAt !== page.updatedAt
  ) {
    throw new ConvexError(
      `${page.updatedByName ?? "Someone else"} edited this page while you were writing`,
    );
  }

  const patch: Record<string, unknown> = {};
  if (args.title !== undefined) {
    const title = args.title.trim();
    if (!title) throw new ConvexError("Page title is required");
    patch.title = title.slice(0, 200);
  }
  if (args.markdown !== undefined) patch.markdown = args.markdown;

  // Snapshot the *previous* content before overwriting it, and only when the
  // content is actually changing — a title-only edit or a no-op save should
  // not create a revision that looks like someone rewrote the page.
  const contentChanging =
    (args.markdown !== undefined && args.markdown !== page.markdown) ||
    (patch.title !== undefined && patch.title !== page.title);
  if (contentChanging) {
    await recordRevision(ctx, page, actor);
  }
  if (args.parentPageId !== undefined) {
    if (args.parentPageId === null) {
      patch.parentPageId = undefined;
    } else {
      const parent = await ctx.db.get(args.parentPageId);
      if (
        !parent ||
        parent.scopeType !== page.scopeType ||
        parent.scopeId !== page.scopeId
      ) {
        throw new ConvexError("That page is in a different workspace");
      }
      await assertNoCycle(ctx, page._id, args.parentPageId);
      patch.parentPageId = args.parentPageId;
    }
  }
  if (Object.keys(patch).length === 0) return { updatedAt: page.updatedAt };

  // `updatedAt` is also the optimistic-concurrency version. Two writes can
  // land in the same millisecond (especially through an MCP agent loop), so a
  // raw Date.now() can leave the version unchanged and let a stale editor
  // overwrite the newer body. Advance monotonically within this page.
  const updatedAt = Math.max(Date.now(), page.updatedAt + 1);
  patch.updatedAt = updatedAt;
  patch.updatedByActorId = actor.id;
  patch.updatedByName = actor.name;
  await ctx.db.patch(page._id, patch);

  const next = (await ctx.db.get(page._id))!;
  if (args.markdown !== undefined) {
    await syncLinks(ctx, next, args.markdown);
    await syncMentions(ctx, next, args.markdown, actor);
    await reindex(ctx, next, args.markdown);
  }
  await publishChange(ctx, next, "page.updated");
  return { updatedAt };
}

/**
 * Deleting a page removes its links and attachments but never the things it
 * was attached to — the same "grouping change, not a content deletion" rule
 * projects follow.
 */
export async function removePageCore(
  ctx: MutationCtx,
  page: Doc<"pages">,
): Promise<void> {
  for (const link of await ctx.db
    .query("pageLinks")
    .withIndex("by_from", (q) => q.eq("fromPageId", page._id))
    .collect()) {
    await ctx.db.delete(link._id);
  }
  for (const link of await ctx.db
    .query("pageLinks")
    .withIndex("by_to", (q) => q.eq("toPageId", page._id))
    .collect()) {
    await ctx.db.delete(link._id);
  }
  for (const att of await ctx.db
    .query("pageAttachments")
    .withIndex("by_page", (q) => q.eq("pageId", page._id))
    .collect()) {
    await ctx.db.delete(att._id);
  }
  await removeMentions(ctx, page._id);
  for (const revision of await ctx.db
    .query("pageRevisions")
    .withIndex("by_page", (q) => q.eq("pageId", page._id))
    .collect()) {
    await ctx.db.delete(revision._id);
  }
  await clearPresence(ctx, "page", page._id);
  // The discussion about a page goes with it — a comment thread whose subject
  // no longer exists is unreachable, not preserved.
  for (const message of await ctx.db
    .query("messages")
    .withIndex("by_parent", (q) =>
      q.eq("parentType", "page").eq("parentId", page._id),
    )
    .collect()) {
    await ctx.db.delete(message._id);
  }
  // Nested pages are promoted to top level rather than deleted with the
  // parent: losing a tree of writing to one click is not recoverable.
  for (const child of await ctx.db
    .query("pages")
    .withIndex("by_parent_page", (q) => q.eq("parentPageId", page._id))
    .collect()) {
    await ctx.db.patch(child._id, { parentPageId: undefined });
  }
  await ctx.scheduler.runAfter(0, internal.aiDb._dropEmbeddings, {
    parentType: "page",
    parentId: page._id,
  });
  await ctx.db.delete(page._id);
}

export async function attachPageCore(
  ctx: MutationCtx,
  page: Doc<"pages">,
  targetType: TargetType,
  targetId: string,
  actor: Actor,
): Promise<Id<"pageAttachments">> {
  const existing = await ctx.db
    .query("pageAttachments")
    .withIndex("by_page_and_target", (q) =>
      q
        .eq("pageId", page._id)
        .eq("targetType", targetType)
        .eq("targetId", targetId),
    )
    .unique();
  // Idempotent — attaching twice is a no-op, and returns the row that already
  // exists so the caller can still pin it.
  if (existing) return existing._id;

  return await ctx.db.insert("pageAttachments", {
    pageId: page._id,
    targetType,
    targetId,
    createdByActorId: actor.id,
    createdAt: Date.now(),
  });
}

// ── Queries ─────────────────────────────────────────────────────────────

export type PageRow = {
  pageId: Id<"pages">;
  title: string;
  excerpt: string;
  parentPageId?: Id<"pages">;
  updatedAt: number;
  updatedByName?: string;
  attachmentCount: number;
};

/** Every page in a scope — the workspace-wide index. */
export const listForScope = query({
  args: {
    scopeType: scopeValidator,
    scopeId: v.string(),
    search: v.optional(v.string()),
  },
  handler: async (ctx, { scopeType, scopeId, search }) => {
    try {
      await requireScopeAccess(ctx, { scopeType, scopeId });
    } catch {
      return [];
    }

    const needle = search?.trim();

    // Searching goes through the full-text index; browsing walks the scope.
    //
    // These are genuinely different reads. Browsing has to enumerate the
    // scope anyway to render the list, so an index would buy nothing. A
    // search over a workspace with thousands of pages must not load every
    // page's markdown into a JS `includes()` — that is the read that stops
    // working first. Titles are matched separately because the search index
    // covers `markdown` only, and "the page called X" is the most common
    // search there is.
    let pages: Doc<"pages">[];
    if (needle) {
      const byBody = await ctx.db
        .query("pages")
        .withSearchIndex("by_text", (q) =>
          q
            .search("markdown", needle)
            .eq("scopeType", scopeType)
            .eq("scopeId", scopeId),
        )
        .take(100);
      const byTitle = await ctx.db
        .query("pages")
        .withSearchIndex("by_title", (q) =>
          q
            .search("title", needle)
            .eq("scopeType", scopeType)
            .eq("scopeId", scopeId),
        )
        .take(50);
      const seen = new Set(byBody.map((p) => p._id as string));
      pages = [...byBody, ...byTitle.filter((p) => !seen.has(p._id))];
    } else {
      pages = await ctx.db
        .query("pages")
        .withIndex("by_scope", (q) =>
          q.eq("scopeType", scopeType).eq("scopeId", scopeId),
        )
        .collect();
    }

    // Newest-edited first, with creation time breaking the tie.
    //
    // Without the tiebreak two pages saved in the same millisecond come back
    // in whatever order the index walk produced — oldest first — so the list
    // silently contradicts its own heading. It is rare enough in production to
    // look like nothing and common enough in a test suite to fail one run in
    // six, which is how it was found.
    pages.sort(
      (a, b) => b.updatedAt - a.updatedAt || b._creationTime - a._creationTime,
    );

    const rows: PageRow[] = [];
    for (const p of pages) {
      if (p.archivedAt !== undefined) continue;
      const attachments = await ctx.db
        .query("pageAttachments")
        .withIndex("by_page", (q) => q.eq("pageId", p._id))
        .collect();
      rows.push({
        pageId: p._id,
        title: p.title,
        excerpt: markdownExcerpt(p.markdown),
        parentPageId: p.parentPageId,
        updatedAt: p.updatedAt,
        updatedByName: p.updatedByName,
        attachmentCount: attachments.length,
      });
    }

    return rows;
  },
});

/** One page, with its backlinks and where it is attached. */
export const get = query({
  args: { pageId: v.id("pages") },
  handler: async (ctx, { pageId }) => {
    let page: Doc<"pages">;
    try {
      ({ page } = await requirePageAccess(ctx, pageId));
    } catch {
      return null;
    }

    const backlinkRows = await ctx.db
      .query("pageLinks")
      .withIndex("by_to", (q) => q.eq("toPageId", pageId))
      .collect();
    const backlinks = [];
    for (const row of backlinkRows) {
      const from = await ctx.db.get(row.fromPageId);
      if (!from) continue;
      try {
        await requireScopeAccess(ctx, {
          scopeType: from.scopeType,
          scopeId: from.scopeId,
        });
      } catch {
        continue;
      }
      backlinks.push({
        pageId: from._id,
        title: from.title,
        excerpt: markdownExcerpt(from.markdown, 100),
      });
    }

    const outgoingRows = await ctx.db
      .query("pageLinks")
      .withIndex("by_from", (q) => q.eq("fromPageId", pageId))
      .collect();
    const outgoing = [];
    for (const row of outgoingRows) {
      const to = await ctx.db.get(row.toPageId);
      if (!to) continue;
      try {
        await requireScopeAccess(ctx, {
          scopeType: to.scopeType,
          scopeId: to.scopeId,
        });
      } catch {
        continue;
      }
      outgoing.push({ pageId: to._id, title: to.title });
    }

    const attachmentRows = await ctx.db
      .query("pageAttachments")
      .withIndex("by_page", (q) => q.eq("pageId", pageId))
      .collect();
    const attachments = [];
    for (const att of attachmentRows) {
      try {
        await requireTargetAccess(ctx, att.targetType, att.targetId);
      } catch {
        continue;
      }
      const label = await labelForTarget(ctx, att.targetType, att.targetId);
      if (label) {
        attachments.push({
          attachmentId: att._id,
          targetType: att.targetType,
          targetId: att.targetId,
          label: label.label,
          href: label.href,
          pinned: att.pinned === true,
        });
      }
    }

    // The trail back to the top, so a nested page says where it sits
    // instead of appearing to float free.
    const ancestors: { pageId: Id<"pages">; title: string }[] = [];
    let cursor = page.parentPageId;
    for (let hops = 0; cursor && hops < 16; hops += 1) {
      const parent: Doc<"pages"> | null = await ctx.db.get(cursor);
      if (!parent) break;
      ancestors.unshift({ pageId: parent._id, title: parent.title });
      cursor = parent.parentPageId;
    }

    const children = (
      await ctx.db
        .query("pages")
        .withIndex("by_parent_page", (q) => q.eq("parentPageId", pageId))
        .collect()
    )
      .filter((c) => c.archivedAt === undefined)
      .sort((a, b) => a.position - b.position)
      .map((c) => ({ pageId: c._id, title: c.title }));

    return { page, backlinks, outgoing, attachments, ancestors, children };
  },
});

/** The pages pinned to one thing — powers the attached-pages panel. */
export const forTarget = query({
  args: { targetType: targetTypeValidator, targetId: v.string() },
  handler: async (ctx, { targetType, targetId }) => {
    try {
      await requireTargetAccess(ctx, targetType, targetId);
    } catch {
      return [];
    }
    const rows = await ctx.db
      .query("pageAttachments")
      .withIndex("by_target", (q) =>
        q.eq("targetType", targetType).eq("targetId", targetId),
      )
      .collect();
    const out: (PageRow & {
      attachmentId: Id<"pageAttachments">;
      pinned: boolean;
    })[] = [];
    for (const row of rows) {
      const page = await ctx.db.get(row.pageId);
      if (!page || page.archivedAt !== undefined) continue;
      out.push({
        pageId: page._id,
        title: page.title,
        excerpt: markdownExcerpt(page.markdown, 140),
        parentPageId: page.parentPageId,
        updatedAt: page.updatedAt,
        updatedByName: page.updatedByName,
        attachmentCount: 0,
        attachmentId: row._id,
        pinned: row.pinned === true,
      });
    }
    // Pinned first: "what an agent gets" is the thing you came here to check.
    out.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return b.updatedAt - a.updatedAt;
    });
    return out;
  },
});

/** Human-readable name + deep link for an attachment chip. */
async function labelForTarget(
  ctx: QueryCtx,
  targetType: TargetType,
  targetId: string,
): Promise<{ label: string; href: string | null } | null> {
  switch (targetType) {
    case "workspace": {
      const ws = await ctx.db.get(targetId as Id<"workspaces">);
      return ws ? { label: ws.name, href: `/dashboard/w/${ws._id}` } : null;
    }
    case "space": {
      const sp = await ctx.db.get(targetId as Id<"spaces">);
      return sp ? { label: sp.name, href: `/dashboard/s/${sp._id}` } : null;
    }
    case "project": {
      const p = await ctx.db.get(targetId as Id<"projects">);
      return p ? { label: p.name, href: `/dashboard/p/${p._id}` } : null;
    }
    case "list": {
      const l = await ctx.db.get(targetId as Id<"lists">);
      return l ? { label: l.name, href: `/dashboard/l/${l._id}` } : null;
    }
    case "task": {
      const t = await ctx.db.get(targetId as Id<"tasks">);
      if (!t) return null;
      return { label: t.title, href: `/dashboard/l/${t.listId}/t/${t._id}` };
    }
    case "agent": {
      const a = await ctx.db.get(targetId as Id<"agents">);
      return a ? { label: a.name, href: `/dashboard/agents/${a._id}` } : null;
    }
    case "goal": {
      const g = await ctx.db.get(targetId as Id<"goals">);
      return g ? { label: g.title, href: null } : null;
    }
    case "sprint": {
      const s = await ctx.db.get(targetId as Id<"sprints">);
      return s ? { label: s.name, href: null } : null;
    }
  }
}

// ── Mutations ───────────────────────────────────────────────────────────

export const create = mutation({
  args: {
    scopeType: scopeValidator,
    scopeId: v.string(),
    title: v.optional(v.string()),
    markdown: v.optional(v.string()),
    parentPageId: v.optional(v.id("pages")),
    // Optional: create and pin in one step, which is how a page nearly always
    // starts life ("write this down about *this* project").
    attachTo: v.optional(
      v.object({ targetType: targetTypeValidator, targetId: v.string() }),
    ),
  },
  handler: async (ctx, args) => {
    const scope: PageScope = {
      scopeType: args.scopeType,
      scopeId: args.scopeId,
    };
    const { subject } = await requireScopeAccess(ctx, scope);
    const actor = await userActor(ctx, subject);

    const pageId = await createPageCore(
      ctx,
      scope,
      {
        title: args.title,
        markdown: args.markdown,
        parentPageId: args.parentPageId,
      },
      actor,
    );

    if (args.attachTo) {
      const targetScope = await requireTargetAccess(
        ctx,
        args.attachTo.targetType,
        args.attachTo.targetId,
      );
      if (
        targetScope.scopeType !== scope.scopeType ||
        targetScope.scopeId !== scope.scopeId
      ) {
        throw new ConvexError(
          "A page can only be attached to things in its own workspace",
        );
      }
      const page = (await ctx.db.get(pageId))!;
      await attachPageCore(
        ctx,
        page,
        args.attachTo.targetType,
        args.attachTo.targetId,
        actor,
      );
    }
    return pageId;
  },
});

export const update = mutation({
  args: {
    pageId: v.id("pages"),
    title: v.optional(v.string()),
    markdown: v.optional(v.string()),
    parentPageId: v.optional(v.union(v.id("pages"), v.null())),
    expectedUpdatedAt: v.optional(v.number()),
  },
  handler: async (ctx, { pageId, ...patch }) => {
    const { page, subject } = await requirePageAccess(ctx, pageId);
    const actor = await userActor(ctx, subject);
    return await updatePageCore(ctx, page, patch, actor);
  },
});

/**
 * Where an image dropped into a page goes.
 *
 * The bytes live in Convex file storage and the markdown holds the storage
 * URL, so an image is still a plain `![alt](url)` an agent can read and a
 * person can paste elsewhere.
 */
export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    await requireIdentity(ctx);
    return await ctx.storage.generateUploadUrl();
  },
});

/** The public URL for something just uploaded, to write into the markdown. */
export const urlForUpload = mutation({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, { storageId }) => {
    await requireIdentity(ctx);
    return await ctx.storage.getUrl(storageId);
  },
});

export const remove = mutation({
  args: { pageId: v.id("pages") },
  handler: async (ctx, { pageId }) => {
    const { page } = await requirePageAccess(ctx, pageId);
    await removePageCore(ctx, page);
  },
});

export const attach = mutation({
  args: {
    pageId: v.id("pages"),
    targetType: targetTypeValidator,
    targetId: v.string(),
    pinned: v.optional(v.boolean()),
  },
  handler: async (ctx, { pageId, targetType, targetId, pinned }) => {
    const { page, subject } = await requirePageAccess(ctx, pageId);
    const targetScope = await requireTargetAccess(ctx, targetType, targetId);
    if (
      targetScope.scopeType !== page.scopeType ||
      targetScope.scopeId !== page.scopeId
    ) {
      throw new ConvexError(
        "A page can only be attached to things in its own workspace",
      );
    }
    const actor = await userActor(ctx, subject);
    const attachmentId = await attachPageCore(
      ctx,
      page,
      targetType,
      targetId,
      actor,
    );
    if (pinned && attachmentId) {
      await ctx.db.patch(attachmentId, { pinned: true });
    }
    return attachmentId;
  },
});

/**
 * Mark an attachment as the canonical context for its target — or unmark it.
 *
 * This is the one distinction worth signifying about a page: not "which of
 * two document types is this" but "will an agent be handed this with the
 * work". Making it visible is what closes the gap between writing the context
 * and knowing the agent will actually get it.
 */
export const setPinned = mutation({
  args: { attachmentId: v.id("pageAttachments"), pinned: v.boolean() },
  handler: async (ctx, { attachmentId, pinned }) => {
    const att = await ctx.db.get(attachmentId);
    if (!att) throw new ConvexError("Attachment not found");
    await requirePageAccess(ctx, att.pageId);
    await requireTargetAccess(ctx, att.targetType, att.targetId);
    await ctx.db.patch(attachmentId, { pinned });
  },
});

/**
 * The pages pinned to a target, for the panel that says what an agent gets.
 *
 * Soft-fails to empty like every other read here: a route transition should
 * not throw, and a caller who can't see the target sees nothing.
 */
export const pinnedForTarget = query({
  args: { targetType: targetTypeValidator, targetId: v.string() },
  handler: async (ctx, { targetType, targetId }) => {
    try {
      await requireTargetAccess(ctx, targetType, targetId);
    } catch {
      return [];
    }
    const rows = await ctx.db
      .query("pageAttachments")
      .withIndex("by_target", (q) =>
        q.eq("targetType", targetType).eq("targetId", targetId),
      )
      .collect();
    const out: {
      pageId: Id<"pages">;
      attachmentId: Id<"pageAttachments">;
      title: string;
      excerpt: string;
      updatedAt: number;
    }[] = [];
    for (const row of rows) {
      if (row.pinned !== true) continue;
      const page = await ctx.db.get(row.pageId);
      if (!page || page.archivedAt !== undefined) continue;
      out.push({
        pageId: page._id,
        attachmentId: row._id,
        title: page.title,
        excerpt: markdownExcerpt(page.markdown, 140),
        updatedAt: page.updatedAt,
      });
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  },
});

export const detach = mutation({
  args: { attachmentId: v.id("pageAttachments") },
  handler: async (ctx, { attachmentId }) => {
    const att = await ctx.db.get(attachmentId);
    if (!att) return;
    await requirePageAccess(ctx, att.pageId);
    await ctx.db.delete(attachmentId);
  },
});

/**
 * Every scope the current user can put a page in, for the "new page" picker
 * and the index's scope switcher.
 */
export const scopesForCurrentUser = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const out: { scopeType: "user" | "workspace"; scopeId: string; name: string }[] =
      [{ scopeType: "user", scopeId: identity.subject, name: "Personal" }];
    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userClerkId", identity.subject))
      .collect();
    for (const m of memberships) {
      const ws = await ctx.db.get(m.workspaceId);
      if (ws) {
        out.push({
          scopeType: "workspace",
          scopeId: ws._id,
          name: ws.name,
        });
      }
    }
    return out;
  },
});

// ── Presence ────────────────────────────────────────────────────────────
//
// Kept as thin adapters over `convex/presence.ts`, which covers every surface
// and both kinds of principal. The page editor was the only caller and there is
// no reason for a second implementation of "who is here" — an agent rewriting a
// page has to appear in the same rail a person does, which a page-only table
// with no actorType could never express.

export const heartbeat = mutation({
  args: {
    pageId: v.id("pages"),
    name: v.string(),
    editing: v.boolean(),
  },
  handler: async (ctx, { pageId, name, editing }) => {
    const { subject } = await requirePageAccess(ctx, pageId);
    await markPresence(
      ctx,
      "page",
      pageId,
      { type: "user", id: subject, name },
      { editing },
    );
  },
});

/** Everyone currently on a page, excluding rows that have gone stale. */
export const viewers = query({
  args: { pageId: v.id("pages") },
  handler: async (ctx, { pageId }) => {
    try {
      await requirePageAccess(ctx, pageId);
    } catch {
      return [];
    }
    return await presenceViewers(ctx, "page", pageId);
  },
});

/**
 * The scope a target belongs to, so a surface that wants to create a page
 * "here" doesn't have to re-derive the walk from a list up to its workspace.
 * Returns null when the caller can't open the target.
 */
export const scopeForTarget = query({
  args: { targetType: targetTypeValidator, targetId: v.string() },
  handler: async (ctx, { targetType, targetId }) => {
    try {
      return await requireTargetAccess(ctx, targetType, targetId);
    } catch {
      return null;
    }
  },
});

/**
 * Everyone a page in this scope can mention: workspace members and the
 * agents scoped to it.
 *
 * Deliberately the same actor shape and the same `@[Name](id)` token the
 * comment composer already uses (src/lib/mentions.ts). A page mentioning
 * someone should mean exactly what a comment mentioning them means.
 */
export const mentionableActors = query({
  args: { scopeType: scopeValidator, scopeId: v.string() },
  handler: async (ctx, { scopeType, scopeId }) => {
    try {
      await requireScopeAccess(ctx, { scopeType, scopeId });
    } catch {
      return [];
    }

    const out: { id: string; name: string; kind: "user" | "agent" }[] = [];

    if (scopeType === "workspace") {
      const memberships = await ctx.db
        .query("memberships")
        .withIndex("by_workspace", (q) =>
          q.eq("workspaceId", scopeId as Id<"workspaces">),
        )
        .collect();
      for (const m of memberships) {
        const user = await ctx.db
          .query("users")
          .withIndex("by_clerk_id", (q) => q.eq("clerkId", m.userClerkId))
          .unique();
        if (user) {
          out.push({
            id: user.clerkId,
            name: user.name ?? user.email,
            kind: "user",
          });
        }
      }
    } else {
      const me = await ctx.db
        .query("users")
        .withIndex("by_clerk_id", (q) => q.eq("clerkId", scopeId))
        .unique();
      if (me) {
        out.push({
          id: me.clerkId,
          name: me.name ?? me.email,
          kind: "user",
        });
      }
    }

    const agents = await ctx.db
      .query("agents")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", scopeType).eq("parentId", scopeId),
      )
      .collect();
    for (const a of agents) {
      if (a.status === "paused") continue;
      out.push({ id: a._id, name: a.name, kind: "agent" });
    }

    return out.sort((a, b) => a.name.localeCompare(b.name));
  },
});

/** Titles in a scope, so the editor can autocomplete [[wikilinks]]. */
export const titlesForScope = query({
  args: { scopeType: scopeValidator, scopeId: v.string() },
  handler: async (ctx, { scopeType, scopeId }) => {
    try {
      await requireScopeAccess(ctx, { scopeType, scopeId });
    } catch {
      return [];
    }
    const pages = await ctx.db
      .query("pages")
      .withIndex("by_scope", (q) =>
        q.eq("scopeType", scopeType).eq("scopeId", scopeId),
      )
      .collect();
    return pages
      .filter((p) => p.archivedAt === undefined)
      .map((p) => ({ pageId: p._id, title: p.title }));
  },
});

// Re-exported so agentApi can resolve a scope without duplicating the walk.
export { requireScopeAccess, requireTargetAccess, getSpaceForList, canAccessSpace };

/**
 * A page's history, newest first.
 *
 * Excerpts rather than full markdown: a list of fifty revisions of a long page
 * is megabytes, and the list only needs to say who changed what and when. The
 * full text comes from `readRevision` when someone actually looks at one.
 */
export const history = query({
  args: { pageId: v.id("pages"), limit: v.optional(v.number()) },
  handler: async (ctx, { pageId, limit }) => {
    try {
      await requirePageAccess(ctx, pageId);
    } catch {
      return [];
    }
    const rows = await ctx.db
      .query("pageRevisions")
      .withIndex("by_page_and_time", (q) => q.eq("pageId", pageId))
      .order("desc")
      .take(Math.min(limit ?? 30, 50));
    return rows.map((r) => ({
      revisionId: r._id,
      title: r.title,
      excerpt: markdownExcerpt(r.markdown, 140),
      actorId: r.actorId,
      actorName: r.actorName,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      /** Characters — enough to show "grew by 400" without sending the text. */
      size: r.markdown.length,
    }));
  },
});

/** One revision in full, for previewing before restoring it. */
export const readRevision = query({
  args: { revisionId: v.id("pageRevisions") },
  handler: async (ctx, { revisionId }) => {
    const revision = await ctx.db.get(revisionId);
    if (!revision) return null;
    try {
      await requirePageAccess(ctx, revision.pageId);
    } catch {
      return null;
    }
    return {
      revisionId: revision._id,
      pageId: revision.pageId,
      title: revision.title,
      markdown: revision.markdown,
      actorName: revision.actorName,
      createdAt: revision.createdAt,
    };
  },
});

/**
 * Put a previous version back.
 *
 * Restoring is an ordinary edit, not a rewind: it goes through
 * `updatePageCore`, which means the version being replaced is itself recorded
 * first. So restoring is undoable by restoring again, links and mentions
 * re-sync, and the page's history stays a straight line rather than a tree
 * nobody can reason about.
 */
export const restoreRevision = mutation({
  args: { revisionId: v.id("pageRevisions") },
  handler: async (ctx, { revisionId }) => {
    const revision = await ctx.db.get(revisionId);
    if (!revision) throw new ConvexError("That version is no longer available");
    const { page, subject } = await requirePageAccess(ctx, revision.pageId);
    const actor = await userActor(ctx, subject);
    await updatePageCore(
      ctx,
      page,
      { title: revision.title, markdown: revision.markdown },
      actor,
    );
    return { pageId: page._id };
  },
});

/**
 * The page a legacy doc became, for redirecting old `/dashboard/d/:id` links.
 *
 * Returns null rather than throwing on anything unresolvable, so a stale
 * bookmark lands on an explanation instead of an error boundary.
 */
export const pageForLegacyDoc = query({
  args: { docId: v.string() },
  handler: async (ctx, { docId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const id = ctx.db.normalizeId("docs", docId);
    if (!id) return null;
    const doc = await ctx.db.get(id);
    if (!doc?.migratedToPageId) return null;
    // Access is the page's access, not the doc's — the doc row is history.
    try {
      await requirePageAccess(ctx, doc.migratedToPageId);
    } catch {
      return null;
    }
    return doc.migratedToPageId;
  },
});
