"use node";

import { v } from "convex/values";
import OpenAI from "openai";
import { action, internalAction } from "./_generated/server";
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
    const doc = await ctx.runQuery(internal.aiDb._getDocForIndex, { docId });
    if (!doc) return;
    const text = `${doc.title}\n\n${tiptapToText(doc.content)}`.trim();
    if (!text) return;
    const truncated = clip(text, 8000);
    const embedding = await client.embeddings.create({
      model: EMBEDDING_MODEL,
      input: truncated,
    });
    await ctx.runMutation(internal.aiDb._upsertEmbedding, {
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
    const task = await ctx.runQuery(internal.aiDb._getTaskForIndex, { taskId });
    if (!task) return;
    const text = `${task.title}\n\n${task.description ?? ""}`.trim();
    if (!text) return;
    const embedding = await client.embeddings.create({
      model: EMBEDDING_MODEL,
      input: clip(text, 8000),
    });
    await ctx.runMutation(internal.aiDb._upsertEmbedding, {
      parentType: "task",
      parentId: taskId,
      scopeType: task.scopeType,
      scopeId: task.scopeId,
      textPreview: clip(text, 240),
      embedding: embedding.data[0].embedding,
    });
  },
});

export const dropEmbeddings = internalAction({
  args: {
    parentType: v.union(v.literal("doc"), v.literal("task")),
    parentId: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.runMutation(internal.aiDb._dropEmbeddings, args);
  },
});

// The internal queries/mutations these actions rely on live in aiDb.ts —
// this file is Node runtime ("use node"), which may only define actions.

// --- Public AI actions ---------------------------------------------------

type BrainSource = {
  parentType: "doc" | "task";
  parentId: string;
  textPreview: string;
};
type BrainResult = { answer: string; sources: BrainSource[] };

export const brainSearch = action({
  args: {
    scopeType: v.union(v.literal("user"), v.literal("workspace")),
    scopeId: v.string(),
    query: v.string(),
  },
  handler: async (ctx, { scopeType, scopeId, query }): Promise<BrainResult> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    // Authorize the scope before doing any work.
    if (scopeType === "user") {
      if (scopeId !== identity.subject) throw new Error("Forbidden");
    } else {
      const ok = await ctx.runQuery(internal.aiDb._isWorkspaceMember, {
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

    const rows = await ctx.runQuery(internal.aiDb._embeddingsByIds, {
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
    const completion = await client.chat.completions.create({
      model: CHAT_MODEL,
      messages: [
        {
          role: "system",
          content:
            "You are an assistant inside a project-management tool. Answer the user's question using ONLY the provided sources. If the sources don't cover it, say so. Cite sources inline like [1].",
        },
        {
          role: "user",
          content: `Sources:\n${context}\n\nQuestion: ${query}`,
        },
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
            "You are an inline writing assistant. Continue the user's document in the same voice. Output prose only, no preamble, no quotation marks, no markdown headings unless the document already uses them.",
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
            "You expand task titles into a 1–3 sentence description that explains the work. Be concrete, no fluff. Output description only, no headings.",
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

