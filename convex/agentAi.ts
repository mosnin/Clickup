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

/**
 * Semantic search across everything this key can read.
 *
 * `kinds` narrows it. The one that motivated the argument is "message":
 * channels and task comments are where reasoning is actually recorded, and
 * being able to ask ONLY for that is the difference between "find me the spec"
 * and "find me where we argued about this".
 *
 * Filtered after the vector search rather than inside it: the index filters on
 * scope alone, and adding a second filter field would mean a schema migration
 * for a narrowing that costs nothing at this result size.
 */
export const search = action({
  args: {
    apiKey: v.string(),
    query: v.string(),
    kinds: v.optional(
      v.array(
        v.union(
          v.literal("doc"),
          v.literal("task"),
          v.literal("page"),
          v.literal("message"),
        ),
      ),
    ),
  },
  handler: async (
    ctx,
    { apiKey, query, kinds },
  ): Promise<{
    configured: boolean;
    results: {
      parentType: "doc" | "task" | "page" | "message";
      parentId: string;
      textPreview: string;
    }[];
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
    // List-restricted agents: drop task hits outside the allow-list (docs
    // pass through — restricted agents can read every doc in scope, same
    // as agentApi.listDocs/getDoc). The vector filter above only scopes by
    // user/workspace, so this second pass enforces the finer boundary.
    const wanted = kinds && kinds.length > 0 ? new Set<string>(kinds) : null;
    const results: {
      parentType: "doc" | "task" | "page" | "message";
      parentId: string;
      textPreview: string;
    }[] = await ctx.runQuery(internal.agentApi._filterSearchHits, {
      apiKey,
      hits: rows
        .filter(
          (r: Doc<"embeddings">) => wanted === null || wanted.has(r.parentType),
        )
        .map((r: Doc<"embeddings">) => ({
          parentType: r.parentType,
          parentId: r.parentId,
          textPreview: r.textPreview,
        })),
    });
    return { configured: true, results };
  },
});
