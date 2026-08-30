import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { convexToJson, jsonToConvex, v } from "convex/values";
import type { GenericQueryCtx, QueryBuilder } from "convex/server";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import type { DataModel } from "../convex/_generated/dataModel";
import {
  dispatchHostedMcp,
  hostedMcpQueryBuilder,
  type HostedMcpRegistry,
} from "../convex/_hostedMcp";
import { HostedMcpClient } from "../src/lib/hosted-mcp-client";

const modules = import.meta.glob("../convex/**/*.*s");
const MCP_RESOURCE = "https://www.operate.to/api/mcp";

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

async function setupOAuthBearer() {
  const t = convexTest(schema, modules);
  const bearer = "opa_hosted_mcp_boundary_secret";
  const now = Date.now();
  const ids = await t.run(async (ctx) => {
    const userClerkId = "hosted_mcp_owner";
    await ctx.db.insert("users", {
      clerkId: userClerkId,
      email: "owner@example.com",
      name: "Owner",
    });
    const workspaceId = await ctx.db.insert("workspaces", {
      name: "Boundary Workspace",
      slug: "boundary-workspace",
      ownerClerkId: userClerkId,
      createdAt: now,
    });
    await ctx.db.insert("memberships", {
      workspaceId,
      userClerkId,
      role: "owner",
      joinedAt: now,
    });
    const agentId = await ctx.db.insert("agents", {
      name: "Boundary Agent",
      parentType: "workspace",
      parentId: workspaceId,
      status: "active",
      createdByClerkId: userClerkId,
      createdAt: now,
    });
    const grantId = "grant_hosted_mcp_boundary";
    await ctx.db.insert("oauthTokenGrants", {
      grantId,
      clientId: "client_hosted_mcp_boundary",
      resource: MCP_RESOURCE,
      userClerkId,
      createdAt: now,
      updatedAt: now,
    });
    const tokenId = await ctx.db.insert("oauthAccessTokens", {
      tokenHash: hash(bearer),
      refreshTokenHash: hash("opr_hosted_mcp_boundary"),
      grantId,
      clientId: "client_hosted_mcp_boundary",
      scopes: ["operate:read", "operate:write"],
      resource: MCP_RESOURCE,
      agentId,
      userClerkId,
      expiresAt: now + 60 * 60 * 1000,
      refreshExpiresAt: now + 30 * 24 * 60 * 60 * 1000,
      createdAt: now,
    });
    return { agentId, tokenId };
  });
  return { t, bearer, ...ids };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("hosted MCP credential boundary", () => {
  it("keeps the raw bearer in Authorization and out of the Convex request body", async () => {
    vi.stubEnv("CONVEX_SITE_URL", "https://boundary.convex.site");
    const rawBearer = "opa_never_serialize_this";
    const fetchMock = vi.fn(async () =>
      Response.json({
        ok: true,
        value: convexToJson({ agentId: "agent_123", name: "Boundary" }),
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await new HostedMcpClient().query(api.agentApi.whoami, {
      apiKey: rawBearer,
    });
    expect(result).toEqual({ agentId: "agent_123", name: "Boundary" });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    const body = String(init.body);
    expect(url).toBe("https://boundary.convex.site/oauth/internal/mcp");
    expect(new Headers(init.headers).get("authorization")).toBe(
      `Bearer ${rawBearer}`,
    );
    expect(body).not.toContain(rawBearer);
    expect(body).not.toContain("apiKey");
    expect(JSON.parse(body)).toEqual({
      functionName: "agentApi:whoami",
      functionType: "query",
      input: {},
    });
  });

  it("authenticates OAuth by hash and runs the original query and mutation handlers", async () => {
    const { t, bearer, agentId } = await setupOAuthBearer();
    const queryResponse = await t.fetch("/oauth/internal/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${bearer}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        functionName: "agentApi:whoami",
        functionType: "query",
        input: {},
      }),
    });
    expect(queryResponse.status).toBe(200);
    const queryPayload = (await queryResponse.json()) as {
      ok: boolean;
      value: Parameters<typeof jsonToConvex>[0];
    };
    expect(queryPayload.ok).toBe(true);
    expect(jsonToConvex(queryPayload.value)).toMatchObject({
      agentId,
      name: "Boundary Agent",
      connection: { authMethod: "oauth" },
    });

    const mutationResponse = await t.fetch("/oauth/internal/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${bearer}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        functionName: "agentApi:connect",
        functionType: "mutation",
        input: convexToJson({ resource: MCP_RESOURCE }),
      }),
    });
    expect(mutationResponse.status).toBe(200);
    const mutationPayload = (await mutationResponse.json()) as {
      ok: boolean;
      value: Parameters<typeof jsonToConvex>[0];
    };
    expect(jsonToConvex(mutationPayload.value)).toMatchObject({ agentId });
  });

  it("routes every hosted MCP namespace and the semantic-search action through hashed authority", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const { t, bearer, agentId } = await setupOAuthBearer();
    const invoke = async (
      functionName: string,
      functionType: "query" | "mutation" | "action",
      input: Record<string, unknown>,
    ) => {
      const response = await t.fetch("/oauth/internal/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${bearer}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ functionName, functionType, input }),
      });
      const payload = (await response.json()) as {
        ok: boolean;
        value?: Parameters<typeof jsonToConvex>[0];
      };
      expect(response.status, functionName).toBe(200);
      expect(payload.ok, functionName).toBe(true);
      return jsonToConvex(payload.value!);
    };

    await expect(
      invoke("buzz/agentChat:identity", "query", {}),
    ).resolves.toMatchObject({ agentId, pubkey: null });
    await expect(
      invoke("agentGrants:myFleet", "query", {}),
    ).resolves.toBeNull();
    await expect(
      invoke("x402:walletByKey", "query", {}),
    ).resolves.toMatchObject({ scopeType: "workspace" });
    await expect(
      invoke("agentAi:search", "action", { query: "launch plan" }),
    ).resolves.toEqual({ configured: false, results: [] });
  });

  it("rejects credential fields, schema drift, and revoked OAuth tokens", async () => {
    const { t, bearer, tokenId, agentId } = await setupOAuthBearer();
    const call = (input: Record<string, unknown>) =>
      t.fetch("/oauth/internal/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${bearer}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          functionName: "agentApi:whoami",
          functionType: "query",
          input,
        }),
      });

    expect((await call({ apiKey: bearer })).status).toBe(400);
    expect((await call({ unexpected: true })).status).toBe(400);
    const wrongIdTable = await t.fetch("/oauth/internal/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${bearer}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        functionName: "agentApi:getTask",
        functionType: "query",
        input: { taskId: agentId },
      }),
    });
    expect(wrongIdTable.status).toBe(400);
    await t.run(async (ctx) => {
      await ctx.db.patch(tokenId, { revokedAt: Date.now() });
    });
    const revoked = await call({});
    expect(revoked.status).toBe(401);
    await expect(revoked.json()).resolves.toMatchObject({
      ok: false,
      error: "invalid_token",
    });
  });

  it("enforces the public return validator after hosted handler dispatch", async () => {
    const registry: HostedMcpRegistry = new Map();
    const passthroughBuilder = ((definition: unknown) =>
      definition) as QueryBuilder<DataModel, "public">;
    const hostedQuery = hostedMcpQueryBuilder(
      registry,
      "invalidReturn",
      passthroughBuilder,
    );
    hostedQuery({
      args: { apiKey: v.string() },
      returns: v.object({ safe: v.boolean() }),
      handler: async () => ({ safe: "validator-bypass" }),
    } as never);
    const ctx = {
      db: { normalizeId: () => null },
    } as unknown as GenericQueryCtx<DataModel>;

    await expect(
      dispatchHostedMcp(registry, ctx, {
        operation: "invalidReturn",
        apiKeyHash: hash("opaque-internal-hash"),
        input: {},
      }),
    ).rejects.toThrow(/invalid hosted MCP return value: expected boolean/i);
  });
});
