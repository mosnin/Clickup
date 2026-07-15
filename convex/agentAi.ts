"use node";

import { v } from "convex/values";
import OpenAI from "openai";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";

// Semantic (Brain) search for agents, authenticated by API key instead of
// Clerk. Same embedding index and scope filter as ai.brainSearch; results
// come back as raw sources (no LLM synthesis) since the calling agent has
// its own model to reason with. Falls back to an error-free empty result
// when OPENAI_API_KEY isn't configured — agents can still use
// agentApi.searchTasks for keyword search.

const EMBEDDING_MODEL = "text-embedding-3-small";

export const search = action({
  args: { apiKey: v.string(), query: v.string() },
  handler: async (
    ctx,
    { apiKey, query },
  ): Promise<{
    configured: boolean;
    results: { parentType: "doc" | "task"; parentId: string; textPreview: string }[];
  }> => {
    const scope = await ctx.runQuery(internal.agentApi._validateKey, {
      apiKey,
    });
    const key = process.env.OPENAI_API_KEY;
    if (!key) return { configured: false, results: [] };
    const client = new OpenAI({ apiKey: key });
    const queryEmbedding = await client.embeddings.create({
      model: EMBEDDING_MODEL,
      input: query,
    });
    const hits = await ctx.vectorSearch("embeddings", "by_embedding", {
      vector: queryEmbedding.data[0].embedding,
      limit: 8,
      filter: (q) => q.eq("scopeId", scope.scopeId),
    });
    const rows = await ctx.runQuery(internal.aiDb._embeddingsByIds, {
      ids: hits.map((h) => h._id),
    });
    return {
      configured: true,
      results: rows.map((r: Doc<"embeddings">) => ({
        parentType: r.parentType,
        parentId: r.parentId,
        textPreview: r.textPreview,
      })),
    };
  },
});
