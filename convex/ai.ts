"use node";

import { v } from "convex/values";
import OpenAI from "openai";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";

// All OpenAI calls live here so the rest of the codebase doesn't depend
// on the SDK. Set OPENAI_API_KEY on the Convex deployment via
//   npx convex env set OPENAI_API_KEY sk-...
//
// Models:
//   - text-embedding-3-small for indexing + search (1536 dims, $0.02/1M)
//   - gpt-4o-mini for chat/generation (cheap default; bump as needed)
const EMBEDDING_MODEL = "text-embedding-3-small";
const CHAT_MODEL = "gpt-4o-mini";

function makeClient(): OpenAI | null {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    console.warn("[ai] OPENAI_API_KEY not set");
    return null;
  }
  return new OpenAI({ apiKey: key });
}

// --- Embedding helpers ----------------------------------------------------

function tiptapToText(content: unknown): string {
  // Walk a ProseMirror doc and extract plain text. Tolerant of the
  // unknown shape — we just look for `text` on every leaf.
  const parts: string[] = [];
  function walk(node: unknown): void {
    if (!node || typeof node !== "object") return;
    const n = node as Record<string, unknown>;
    if (typeof n.text === "string") parts.push(n.text);
    if (Array.isArray(n.content)) for (const c of n.content) walk(c);
  }
  walk(content);
  return parts.join(" ").trim();
}

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

// --- Index actions: called from mutations via ctx.scheduler --------------

export const indexDocument = internalAction({
  args: { docId: v.id("docs") },
  handler: async (ctx, { docId }) => {
    const client = makeClient();
    if (!client) return;
    const doc = await ctx.runQuery(internal.ai._getDocForIndex, { docId });
    if (!doc) return;
    const text = `${doc.title}\n\n${tiptapToText(doc.content)}`.trim();
    if (!text) return;
    const truncated = clip(text, 8000);
    const embedding = await client.embeddings.create({
      model: EMBEDDING_MODEL,
      input: truncated,
    });
    await ctx.runMutation(internal.ai._upsertEmbedding, {
      parentType: "doc",
      parentId: docId,
      scopeType: doc.scopeType,
      scopeId: doc.scopeId,
      textPreview: clip(text, 240),
      embedding: embedding.data[0].embedding,
    });
  },
});

export const indexTask = internalAction({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, { taskId }) => {
    const client = makeClient();
    if (!client) return;
    const task = await ctx.runQuery(internal.ai._getTaskForIndex, { taskId });
    if (!task) return;
    const text = `${task.title}\n\n${task.description ?? ""}`.trim();
    if (!text) return;
    const embedding = await client.embeddings.create({
      model: EMBEDDING_MODEL,
      input: clip(text, 8000),
    });
    await ctx.runMutation(internal.ai._upsertEmbedding, {
      parentType: "task",
      parentId: taskId,
      scopeType: task.scopeType,
      scopeId: task.scopeId,
      textPreview: clip(text, 240),
      embedding: embedding.data[0].embedding,
    });
  },
});

export const indexMessage = internalAction({
  args: { messageId: v.id("messages") },
  handler: async (ctx, { messageId }) => {
    const client = makeClient();
    if (!client) return;
    const msg = await ctx.runQuery(internal.ai._getMessageForIndex, {
      messageId,
    });
    if (!msg) return;
    const text = msg.body.replace(/@\[([^\]]+)\]\([^)]+\)/g, "@$1").trim();
    if (!text) return;
    const embedding = await client.embeddings.create({
      model: EMBEDDING_MODEL,
      input: clip(text, 8000),
    });
    await ctx.runMutation(internal.ai._upsertEmbedding, {
      parentType: "message",
      parentId: messageId,
      scopeType: msg.scopeType,
      scopeId: msg.scopeId,
      textPreview: clip(text, 240),
      embedding: embedding.data[0].embedding,
    });
  },
});

export const dropEmbeddings = internalAction({
  args: {
    parentType: v.union(
      v.literal("doc"),
      v.literal("task"),
      v.literal("message"),
    ),
    parentId: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.runMutation(internal.ai._dropEmbeddings, args);
  },
});

// --- Internal helpers (queries + mutations) used by the actions above ----

export const _getDocForIndex = internalQuery({
  args: { docId: v.id("docs") },
  handler: async (ctx, { docId }) => {
    const doc = await ctx.db.get(docId);
    if (!doc) return null;
    const scope = await scopeForDocLikeParent(ctx, doc.parentType, doc.parentId);
    if (!scope) return null;
    return {
      title: doc.title,
      content: doc.content,
      scopeType: scope.scopeType,
      scopeId: scope.scopeId,
    };
  },
});

export const _getTaskForIndex = internalQuery({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, { taskId }) => {
    const task = await ctx.db.get(taskId);
    if (!task) return null;
    const list = await ctx.db.get(task.listId);
    if (!list) return null;
    let space: Doc<"spaces"> | null = null;
    if (list.parentType === "space") {
      space = await ctx.db.get(list.parentId as Id<"spaces">);
    } else {
      const folder = await ctx.db.get(list.parentId as Id<"folders">);
      if (folder) space = await ctx.db.get(folder.spaceId);
    }
    if (!space) return null;
    return {
      title: task.title,
      description: task.description,
      scopeType: space.parentType,
      scopeId: space.parentId,
    };
  },
});

// Resolves a message's scope by walking back to its parent (task | space
// | workspace). Workspace messages scope to the workspace; space and
// task messages inherit the space's scope (personal-user vs. workspace).
export const _getMessageForIndex = internalQuery({
  args: { messageId: v.id("messages") },
  handler: async (ctx, { messageId }) => {
    const msg = await ctx.db.get(messageId);
    if (!msg) return null;
    let scope: { scopeType: "user" | "workspace"; scopeId: string } | null =
      null;
    if (msg.parentType === "workspace") {
      scope = { scopeType: "workspace", scopeId: msg.parentId };
    } else if (msg.parentType === "space") {
      const space = await ctx.db.get(msg.parentId as Id<"spaces">);
      if (space) {
        scope = { scopeType: space.parentType, scopeId: space.parentId };
      }
    } else {
      const task = await ctx.db.get(msg.parentId as Id<"tasks">);
      if (task) {
        const list = await ctx.db.get(task.listId);
        if (list) {
          let space: Doc<"spaces"> | null = null;
          if (list.parentType === "space") {
            space = await ctx.db.get(list.parentId as Id<"spaces">);
          } else {
            const folder = await ctx.db.get(list.parentId as Id<"folders">);
            if (folder) space = await ctx.db.get(folder.spaceId);
          }
          if (space) {
            scope = { scopeType: space.parentType, scopeId: space.parentId };
          }
        }
      }
    }
    if (!scope) return null;
    return { body: msg.body, ...scope };
  },
});

async function scopeForDocLikeParent(
  ctx: { db: import("./_generated/server").QueryCtx["db"] },
  parentType: "user" | "workspace" | "space",
  parentId: string,
): Promise<{ scopeType: "user" | "workspace"; scopeId: string } | null> {
  if (parentType === "user") return { scopeType: "user", scopeId: parentId };
  if (parentType === "workspace") {
    return { scopeType: "workspace", scopeId: parentId };
  }
  const space = await ctx.db.get(parentId as Id<"spaces">);
  if (!space) return null;
  return { scopeType: space.parentType, scopeId: space.parentId };
}

export const _upsertEmbedding = internalMutation({
  args: {
    parentType: v.union(
      v.literal("doc"),
      v.literal("task"),
      v.literal("message"),
    ),
    parentId: v.string(),
    scopeType: v.union(v.literal("user"), v.literal("workspace")),
    scopeId: v.string(),
    textPreview: v.string(),
    embedding: v.array(v.float64()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("embeddings")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", args.parentType).eq("parentId", args.parentId),
      )
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, {
        scopeType: args.scopeType,
        scopeId: args.scopeId,
        textPreview: args.textPreview,
        embedding: args.embedding,
        updatedAt: Date.now(),
      });
      return;
    }
    await ctx.db.insert("embeddings", { ...args, updatedAt: Date.now() });
  },
});

export const _dropEmbeddings = internalMutation({
  args: {
    parentType: v.union(
      v.literal("doc"),
      v.literal("task"),
      v.literal("message"),
    ),
    parentId: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("embeddings")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", args.parentType).eq("parentId", args.parentId),
      )
      .collect();
    for (const e of existing) await ctx.db.delete(e._id);
  },
});

// --- Public AI actions ---------------------------------------------------

type BrainSource = {
  parentType: "doc" | "task" | "message";
  parentId: string;
  textPreview: string;
};
type BrainResult = { answer: string; sources: BrainSource[] };

export const brainSearch = action({
  args: {
    scopeType: v.union(v.literal("user"), v.literal("workspace")),
    scopeId: v.string(),
    query: v.string(),
    // Optional page context — when the caller knows what the user was
    // looking at when they asked, we resolve the entity title/preview
    // and prepend it to the system prompt. Lets "summarize this" or
    // "what's blocking it" do the right thing without restating the
    // subject.
    currentTaskId: v.optional(v.id("tasks")),
    currentListId: v.optional(v.id("lists")),
    currentDocId: v.optional(v.id("docs")),
  },
  handler: async (
    ctx,
    {
      scopeType,
      scopeId,
      query,
      currentTaskId,
      currentListId,
      currentDocId,
    },
  ): Promise<BrainResult> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    // Authorize the scope before doing any work.
    if (scopeType === "user") {
      if (scopeId !== identity.subject) throw new Error("Forbidden");
    } else {
      const ok = await ctx.runQuery(internal.ai._isWorkspaceMember, {
        workspaceId: scopeId as Id<"workspaces">,
      });
      if (!ok) throw new Error("Forbidden");
    }

    const client = makeClient();
    if (!client) {
      return {
        answer: "AI is not configured on this server.",
        sources: [],
      };
    }

    const pageContext: string | null = await ctx.runQuery(
      internal.ai._brainPageContext,
      { currentTaskId, currentListId, currentDocId },
    );

    const queryEmbedding = await client.embeddings.create({
      model: EMBEDDING_MODEL,
      input: query,
    });
    const vector = queryEmbedding.data[0].embedding;

    // Convex vector search filters only allow a single equality. scopeId
    // is uniquely identifying on its own — Clerk subject IDs and Convex
    // workspace IDs never collide — so filtering by scopeId is enough to
    // contain results to the requested boundary.
    const hits = await ctx.vectorSearch("embeddings", "by_embedding", {
      vector,
      limit: 6,
      filter: (q) => q.eq("scopeId", scopeId),
    });

    const rows = await ctx.runQuery(internal.ai._embeddingsByIds, {
      ids: hits.map((h) => h._id),
    });
    const sources: BrainSource[] = rows.map(
      (r: Doc<"embeddings">): BrainSource => ({
        parentType: r.parentType,
        parentId: r.parentId,
        textPreview: r.textPreview,
      }),
    );

    if (sources.length === 0) {
      return {
        answer:
          "I couldn't find anything in your workspace that matches that question.",
        sources,
      };
    }

    const context = sources
      .map(
        (s: BrainSource, i: number) =>
          `[${i + 1}] (${s.parentType}) ${s.textPreview.replace(/\n/g, " ")}`,
      )
      .join("\n");
    const systemContent =
      "You are an assistant inside a project-management tool. Answer the user's question using ONLY the provided sources. If the sources don't cover it, say so. Cite sources inline like [1].";
    const userContent = pageContext
      ? `The user is currently viewing:\n${pageContext}\n\nSources:\n${context}\n\nQuestion: ${query}`
      : `Sources:\n${context}\n\nQuestion: ${query}`;
    const completion = await client.chat.completions.create({
      model: CHAT_MODEL,
      messages: [
        { role: "system", content: systemContent },
        { role: "user", content: userContent },
      ],
      max_tokens: 600,
    });

    return {
      answer:
        completion.choices[0]?.message?.content?.trim() ??
        "(No response)",
      sources,
    };
  },
});

export const writerContinue = action({
  args: { prompt: v.string(), context: v.optional(v.string()) },
  handler: async (ctx, { prompt, context }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");
    const client = makeClient();
    if (!client) {
      return "AI is not configured on this server.";
    }
    const completion = await client.chat.completions.create({
      model: CHAT_MODEL,
      messages: [
        {
          role: "system",
          content:
            "You are an inline writing assistant. Continue the user's document in the same voice. Output prose only — no preamble, no quotation marks, no markdown headings unless the document already uses them.",
        },
        ...(context
          ? [
              {
                role: "user" as const,
                content: `Document so far:\n${context}`,
              },
            ]
          : []),
        { role: "user", content: prompt },
      ],
      max_tokens: 400,
    });
    return completion.choices[0]?.message?.content?.trim() ?? "";
  },
});

export const taskAutofill = action({
  args: { title: v.string() },
  handler: async (ctx, { title }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");
    const client = makeClient();
    if (!client) {
      return { description: "" };
    }
    const completion = await client.chat.completions.create({
      model: CHAT_MODEL,
      messages: [
        {
          role: "system",
          content:
            "You expand task titles into a 1–3 sentence description that explains the work. Be concrete, no fluff. Output description only — no headings.",
        },
        { role: "user", content: `Task title: ${title}` },
      ],
      max_tokens: 200,
    });
    return {
      description:
        completion.choices[0]?.message?.content?.trim() ?? "",
    };
  },
});

// Resolve the optional currentTaskId/currentListId/currentDocId trio
// that brainSearch accepts into a short string the model can use as
// "you're looking at this right now". Skips silently if the caller
// can't access the entity — Brain just falls back to scoped search.
export const _brainPageContext = internalQuery({
  args: {
    currentTaskId: v.optional(v.id("tasks")),
    currentListId: v.optional(v.id("lists")),
    currentDocId: v.optional(v.id("docs")),
  },
  handler: async (
    ctx,
    { currentTaskId, currentListId, currentDocId },
  ): Promise<string | null> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;

    const parts: string[] = [];
    if (currentTaskId) {
      const t = await ctx.db.get(currentTaskId);
      if (t && !t.deletedAt) {
        const desc = (t.description ?? "").trim();
        parts.push(
          `Task "${t.title}"${desc ? `: ${clip(desc, 400)}` : ""}`,
        );
      }
    }
    if (currentListId) {
      const l = await ctx.db.get(currentListId);
      if (l && !l.deletedAt) parts.push(`List "${l.name}"`);
    }
    if (currentDocId) {
      const d = await ctx.db.get(currentDocId);
      if (d && !d.deletedAt) {
        const body = clip(tiptapToText(d.content), 400);
        parts.push(`Doc "${d.title}"${body ? `: ${body}` : ""}`);
      }
    }
    return parts.length ? parts.join("\n") : null;
  },
});

export const _isWorkspaceMember = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, { workspaceId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return false;
    const m = await ctx.db
      .query("memberships")
      .withIndex("by_user_and_workspace", (q) =>
        q.eq("userClerkId", identity.subject).eq("workspaceId", workspaceId),
      )
      .unique();
    return m !== null;
  },
});

// Returns every list the caller can drop a task into within the given
// scope (their personal space, or a specific workspace), plus every
// person they can assign. Used as context for the quickTask action so
// the model picks a real listId / clerkId rather than hallucinating.
type QuickTaskContext = {
  lists: Array<{
    id: Id<"lists">;
    name: string;
    spaceName: string;
    folderName: string | null;
  }>;
  members: Array<{ clerkId: string; name: string; email: string }>;
  meClerkId: string;
};

export const _quickTaskContext = internalQuery({
  args: {
    scopeType: v.union(v.literal("user"), v.literal("workspace")),
    scopeId: v.string(),
  },
  handler: async (ctx, { scopeType, scopeId }): Promise<QuickTaskContext> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    if (scopeType === "user") {
      if (scopeId !== identity.subject) throw new Error("Forbidden");
    } else {
      const m = await ctx.db
        .query("memberships")
        .withIndex("by_user_and_workspace", (q) =>
          q
            .eq("userClerkId", identity.subject)
            .eq("workspaceId", scopeId as Id<"workspaces">),
        )
        .unique();
      if (!m) throw new Error("Forbidden");
    }

    const spaces = await ctx.db
      .query("spaces")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", scopeType).eq("parentId", scopeId),
      )
      .collect();

    const lists: QuickTaskContext["lists"] = [];
    for (const space of spaces) {
      const direct = await ctx.db
        .query("lists")
        .withIndex("by_parent", (q) =>
          q.eq("parentType", "space").eq("parentId", space._id),
        )
        .collect();
      for (const l of direct) {
        if (l.deletedAt) continue;
        lists.push({
          id: l._id,
          name: l.name,
          spaceName: space.name,
          folderName: null,
        });
      }
      const folders = await ctx.db
        .query("folders")
        .withIndex("by_space", (q) => q.eq("spaceId", space._id))
        .collect();
      for (const f of folders) {
        if (f.deletedAt) continue;
        const fLists = await ctx.db
          .query("lists")
          .withIndex("by_parent", (q) =>
            q.eq("parentType", "folder").eq("parentId", f._id),
          )
          .collect();
        for (const l of fLists) {
          if (l.deletedAt) continue;
          lists.push({
            id: l._id,
            name: l.name,
            spaceName: space.name,
            folderName: f.name,
          });
        }
      }
    }

    const members: QuickTaskContext["members"] = [];
    if (scopeType === "workspace") {
      const ms = await ctx.db
        .query("memberships")
        .withIndex("by_workspace", (q) =>
          q.eq("workspaceId", scopeId as Id<"workspaces">),
        )
        .collect();
      for (const m of ms) {
        const u = await ctx.db
          .query("users")
          .withIndex("by_clerk_id", (q) => q.eq("clerkId", m.userClerkId))
          .unique();
        if (!u) continue;
        members.push({
          clerkId: u.clerkId,
          name: u.name ?? u.email,
          email: u.email,
        });
      }
    } else {
      const me = await ctx.db
        .query("users")
        .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
        .unique();
      if (me) {
        members.push({
          clerkId: me.clerkId,
          name: me.name ?? me.email,
          email: me.email,
        });
      }
    }

    return { lists, members, meClerkId: identity.subject };
  },
});

// Quick Task — Pace's headline AI feature. Takes a sentence, returns a
// task on the right list with priority/due/assignees inferred. The
// model is forced into a single tool call so we get strict, validated
// arguments back; we then call tasks.create with the resolved values
// (which re-runs auth + automations + indexing the normal way).
//
// Date handling is offset-based: the model returns "days from today"
// rather than an ISO date, because relative dates ("tomorrow", "next
// Friday") are what users say and absolute dates are what models
// hallucinate. We snap to end-of-day UTC so the calendar/Gantt views
// don't wobble across timezones.
type QuickTaskResult =
  | {
      ok: true;
      taskId: Id<"tasks">;
      listId: Id<"lists">;
      title: string;
      explanation: string;
    }
  | { ok: false; error: string };

export const quickTask = action({
  args: {
    prompt: v.string(),
    scopeType: v.union(v.literal("user"), v.literal("workspace")),
    scopeId: v.string(),
    currentListId: v.optional(v.id("lists")),
  },
  handler: async (
    ctx,
    { prompt, scopeType, scopeId, currentListId },
  ): Promise<QuickTaskResult> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    const trimmed = prompt.trim();
    if (!trimmed) return { ok: false, error: "Empty prompt." };

    const client = makeClient();
    if (!client) {
      return { ok: false, error: "AI is not configured on this server." };
    }

    const context: QuickTaskContext = await ctx.runQuery(
      internal.ai._quickTaskContext,
      { scopeType, scopeId },
    );
    if (context.lists.length === 0) {
      return {
        ok: false,
        error:
          "No lists available. Create a list first, then try again.",
      };
    }

    const listChoices = context.lists.map((l) => ({
      id: l.id,
      label: l.folderName
        ? `${l.spaceName} / ${l.folderName} / ${l.name}`
        : `${l.spaceName} / ${l.name}`,
    }));

    const memberChoices = context.members.map((m) => ({
      clerkId: m.clerkId,
      label: m.clerkId === context.meClerkId ? `${m.name} (me)` : m.name,
    }));

    const tools = [
      {
        type: "function" as const,
        function: {
          name: "create_task",
          description:
            "Create a single task with attributes inferred from the user's sentence.",
          parameters: {
            type: "object",
            required: ["title", "listId", "explanation"],
            properties: {
              title: {
                type: "string",
                description:
                  "A concise task title (max 80 chars). Strip prefixes like 'remind me to' or 'create a task to'.",
              },
              listId: {
                type: "string",
                description: "The id of the list to put this task in.",
                enum: listChoices.map((c) => c.id),
              },
              priority: {
                type: "string",
                description:
                  "Use 'urgent' only for explicit urgency words. Default to 'normal'.",
                enum: ["urgent", "high", "normal", "low"],
              },
              dueOffsetDays: {
                type: "number",
                description:
                  "Days from today for the due date. 0=today, 1=tomorrow. Omit if no date is implied.",
              },
              assigneeClerkIds: {
                type: "array",
                description:
                  "Clerk ids of people to assign. Leave empty if nobody specific is mentioned.",
                items: {
                  type: "string",
                  enum: memberChoices.map((m) => m.clerkId),
                },
              },
              explanation: {
                type: "string",
                description:
                  "One short sentence (max 100 chars) describing what was inferred, e.g. 'Added to Personal/Inbox, due tomorrow'.",
              },
            },
          },
        },
      },
    ];

    const today = new Date();
    const dateStr = today.toISOString().slice(0, 10);
    const weekday = today.toLocaleDateString("en-US", {
      weekday: "long",
      timeZone: "UTC",
    });

    const listsText = listChoices
      .map((c) => `- ${c.id}: ${c.label}`)
      .join("\n");
    const membersText = memberChoices.length
      ? memberChoices.map((m) => `- ${m.clerkId}: ${m.label}`).join("\n")
      : "- (no other members)";
    const currentListLine = currentListId
      ? `\nThe user is currently viewing list ${currentListId}. Prefer it when no other list fits.`
      : "";

    let completion;
    try {
      completion = await client.chat.completions.create({
        model: CHAT_MODEL,
        messages: [
          {
            role: "system",
            content:
              "You convert a sentence into a single task. Always call the create_task tool exactly once. Pick a real listId from the list of choices. If a person is named, match against the members list. Convert relative dates to dueOffsetDays from today.",
          },
          {
            role: "user",
            content: `Today is ${weekday}, ${dateStr} (UTC).${currentListLine}\n\nLists:\n${listsText}\n\nMembers:\n${membersText}\n\nUser said: ${trimmed}`,
          },
        ],
        tools,
        tool_choice: {
          type: "function",
          function: { name: "create_task" },
        },
        max_tokens: 400,
      });
    } catch (err) {
      console.warn("[ai.quickTask] OpenAI call failed:", err);
      return { ok: false, error: "AI request failed. Try again." };
    }

    const call = completion.choices[0]?.message?.tool_calls?.[0];
    if (!call || call.function.name !== "create_task") {
      return { ok: false, error: "AI didn't return a usable task." };
    }

    let parsed: {
      title?: string;
      listId?: string;
      priority?: "urgent" | "high" | "normal" | "low";
      dueOffsetDays?: number;
      assigneeClerkIds?: string[];
      explanation?: string;
    };
    try {
      parsed = JSON.parse(call.function.arguments);
    } catch {
      return { ok: false, error: "AI returned malformed arguments." };
    }

    const title = (parsed.title ?? "").trim().slice(0, 200);
    if (!title) return { ok: false, error: "No title in AI response." };

    const listMatch = listChoices.find((c) => c.id === parsed.listId);
    if (!listMatch) {
      return { ok: false, error: "AI picked an unknown list." };
    }
    const listId = listMatch.id as Id<"lists">;

    const validAssignees = (parsed.assigneeClerkIds ?? []).filter((cid) =>
      memberChoices.some((m) => m.clerkId === cid),
    );

    let dueDate: number | undefined;
    if (typeof parsed.dueOffsetDays === "number") {
      const days = Math.max(-3650, Math.min(3650, Math.round(parsed.dueOffsetDays)));
      const d = new Date();
      d.setUTCHours(23, 59, 0, 0);
      d.setUTCDate(d.getUTCDate() + days);
      dueDate = d.getTime();
    }

    const taskId: Id<"tasks"> = await ctx.runMutation(
      internal.ai._createTaskFromQuick,
      {
        listId,
        title,
        priority: parsed.priority,
        dueDate,
        assigneeClerkIds: validAssignees,
      },
    );

    return {
      ok: true,
      taskId,
      listId,
      title,
      explanation: (parsed.explanation ?? "").slice(0, 200),
    };
  },
});

// Internal mutation: thin wrapper around tasks.create that the
// quickTask action calls. Lives here (and not in tasks.ts) so its
// internal-only visibility is obvious — only the action that already
// authorized the scope should reach it.
export const _createTaskFromQuick = internalMutation({
  args: {
    listId: v.id("lists"),
    title: v.string(),
    priority: v.optional(
      v.union(
        v.literal("urgent"),
        v.literal("high"),
        v.literal("normal"),
        v.literal("low"),
      ),
    ),
    dueDate: v.optional(v.number()),
    assigneeClerkIds: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    const list = await ctx.db.get(args.listId);
    if (!list || list.deletedAt) throw new Error("List not found");

    // Resolve to space → check membership/ownership the same way
    // requireListAccess does.
    let space: Doc<"spaces"> | null = null;
    if (list.parentType === "space") {
      space = await ctx.db.get(list.parentId as Id<"spaces">);
    } else {
      const folder = await ctx.db.get(list.parentId as Id<"folders">);
      if (folder) space = await ctx.db.get(folder.spaceId);
    }
    if (!space) throw new Error("List has no space");

    if (space.parentType === "user") {
      if (space.parentId !== identity.subject) throw new Error("Forbidden");
    } else {
      const m = await ctx.db
        .query("memberships")
        .withIndex("by_user_and_workspace", (q) =>
          q
            .eq("userClerkId", identity.subject)
            .eq("workspaceId", space!.parentId as Id<"workspaces">),
        )
        .unique();
      if (!m) throw new Error("Forbidden");
    }

    const statuses = await ctx.db
      .query("listStatuses")
      .withIndex("by_list", (q) => q.eq("listId", args.listId))
      .collect();
    if (statuses.length === 0) throw new Error("List has no statuses");
    const sorted = [...statuses].sort((a, b) => a.position - b.position);
    const openStatus =
      sorted.find((s) => s.category === "open") ?? sorted[0];

    const siblings = await ctx.db
      .query("tasks")
      .withIndex("by_list", (q) => q.eq("listId", args.listId))
      .collect();

    const taskId = await ctx.db.insert("tasks", {
      listId: args.listId,
      title: args.title,
      statusId: openStatus._id,
      priority: args.priority,
      dueDate: args.dueDate,
      assigneeClerkIds: args.assigneeClerkIds,
      createdByClerkId: identity.subject,
      position: siblings.length,
      createdAt: Date.now(),
    });

    await ctx.scheduler.runAfter(0, internal.ai.indexTask, { taskId });

    return taskId;
  },
});

export const _embeddingsByIds = internalQuery({
  args: { ids: v.array(v.id("embeddings")) },
  handler: async (ctx, { ids }) => {
    const rows = await Promise.all(ids.map((id) => ctx.db.get(id)));
    return rows.filter((r): r is NonNullable<typeof r> => r !== null);
  },
});
