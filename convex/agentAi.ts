"use node";

import { v } from "convex/values";
import OpenAI from "openai";
import { action, internalAction } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";

// Semantic (Brain) search for agents, authenticated by API key instead of
// Clerk. Same embedding index and scope filter as ai.brainSearch; results
// come back as raw sources (no LLM synthesis) since the calling agent has
// its own model to reason with. Falls back to an error-free empty result
// when OPENAI_API_KEY isn't configured — agents can still use
// agentApi.searchTasks for keyword search.

const EMBEDDING_MODEL = "text-embedding-3-small";

type SearchResult = {
  configured: boolean;
  results: {
    parentType: "doc" | "task" | "page" | "message";
    parentId: string;
    textPreview: string;
  }[];
};

type SearchArgs = {
  query: string;
  kinds?: ("doc" | "task" | "page" | "message")[];
};

async function searchCore(
  ctx: ActionCtx,
  args: SearchArgs,
  scopeId: string,
  filterHits: (
    hits: SearchResult["results"],
  ) => Promise<SearchResult["results"]>,
): Promise<SearchResult> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return { configured: false, results: [] };
  const client = new OpenAI({ apiKey: key });
  const queryEmbedding = await client.embeddings.create({
    model: EMBEDDING_MODEL,
    input: args.query,
  });
  const hits = await ctx.vectorSearch("embeddings", "by_embedding", {
    vector: queryEmbedding.data[0].embedding,
    limit: 8,
    filter: (q) => q.eq("scopeId", scopeId),
  });
  const rows = await ctx.runQuery(internal.aiDb._embeddingsByIds, {
    ids: hits.map((h) => h._id),
  });
  const wanted =
    args.kinds && args.kinds.length > 0 ? new Set<string>(args.kinds) : null;
  return {
    configured: true,
    results: await filterHits(
      rows
        .filter(
          (row: Doc<"embeddings">) =>
            wanted === null || wanted.has(row.parentType),
        )
        .map((row: Doc<"embeddings">) => ({
          parentType: row.parentType,
          parentId: row.parentId,
          textPreview: row.textPreview,
        })),
    ),
  };
}

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
  handler: async (ctx, { apiKey, query, kinds }): Promise<SearchResult> => {
    const scope = await ctx.runQuery(internal.agentApi._validateKey, {
      apiKey,
    });
    return await searchCore(
      ctx,
      { query, kinds },
      scope.scopeId,
      async (hits) =>
        await ctx.runQuery(internal.agentApi._filterSearchHits, {
          apiKey,
          hits,
        }),
    );
  },
});

export const _hostedMcpSearch = internalAction({
  args: {
    apiKeyHash: v.string(),
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
  handler: async (ctx, { apiKeyHash, query, kinds }): Promise<SearchResult> => {
    const scope = await ctx.runQuery(internal.agentApi._validateKeyHash, {
      apiKeyHash,
    });
    return await searchCore(
      ctx,
      { query, kinds },
      scope.scopeId,
      async (hits) =>
        await ctx.runQuery(internal.agentApi._filterSearchHitsHash, {
          apiKeyHash,
          hits,
        }),
    );
  },
});
