import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import type {
  ConnectorAccount,
  ConnectorInstallation,
  ConnectorSnapshot,
} from "../src/lib/companyos-connect";

const modules = import.meta.glob("../convex/**/*.*s");
const OWNER = { subject: "companyos_owner", email: "owner@example.com" };
const OTHER = { subject: "companyos_other", email: "other@example.com" };
const MEMBER = { subject: "companyos_member", email: "member@example.com" };
const CLIENT_ID = "opc_companyos_test";
const REDIRECT_URI = "https://www.companyos.sh/api/marketplace/oauth/operate/callback";
const RESOURCE = "https://www.operate.to/api/companyos";
const MCP_RESOURCE = "https://www.operate.to/api/mcp";
const VERIFIER = "v".repeat(64);
const CHALLENGE = createHash("sha256")
  .update(VERIFIER)
  .digest("base64url");

function credentialHash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const workspaceId = await ctx.db.insert("workspaces", {
      name: "Acme Operations",
      slug: "acme-operations",
      ownerClerkId: OWNER.subject,
      createdAt: 1,
    });
    const otherWorkspaceId = await ctx.db.insert("workspaces", {
      name: "Other Company",
      slug: "other-company",
      ownerClerkId: OTHER.subject,
      createdAt: 2,
    });
    await ctx.db.insert("memberships", {
      workspaceId,
      userClerkId: OWNER.subject,
      role: "owner",
      joinedAt: 1,
    });
    await ctx.db.insert("memberships", {
      workspaceId,
      userClerkId: MEMBER.subject,
      role: "member",
      joinedAt: 1,
    });
    await ctx.db.insert("memberships", {
      workspaceId: otherWorkspaceId,
      userClerkId: OTHER.subject,
      role: "owner",
      joinedAt: 2,
    });
    await ctx.db.insert("users", {
      clerkId: OWNER.subject,
      email: OWNER.email,
      emailVerified: true,
      name: "Owner",
    });

    const spaceId = await ctx.db.insert("spaces", {
      name: "Operations",
      parentType: "workspace",
      parentId: workspaceId,
      position: 0,
      createdAt: 10,
    });
    const secondSpaceId = await ctx.db.insert("spaces", {
      name: "Engineering",
      parentType: "workspace",
      parentId: workspaceId,
      position: 1,
      createdAt: 11,
    });
    const foreignSpaceId = await ctx.db.insert("spaces", {
      name: "Foreign",
      parentType: "workspace",
      parentId: otherWorkspaceId,
      position: 0,
      createdAt: 12,
    });
    const projectId = await ctx.db.insert("projects", {
      name: "Launch",
      spaceId,
      position: 0,
      createdAt: 20,
    });
    const listId = await ctx.db.insert("lists", {
      name: "Launch tasks",
      parentType: "project",
      parentId: projectId,
      position: 0,
      createdAt: 30,
    });
    const legacyFolderId = await ctx.db.insert("folders", {
      name: "Legacy launch",
      spaceId,
      position: 1,
      createdAt: 32,
    });
    const legacyListId = await ctx.db.insert("lists", {
      name: "Legacy tasks",
      parentType: "folder",
      parentId: legacyFolderId,
      position: 0,
      createdAt: 33,
    });
    const statusId = await ctx.db.insert("listStatuses", {
      listId,
      name: "Open",
      color: "#000000",
      category: "open",
      position: 0,
      createdAt: 31,
    });
    const taskId = await ctx.db.insert("tasks", {
      listId,
      title: "Prepare launch",
      statusId,
      assigneeClerkIds: [],
      createdByClerkId: OWNER.subject,
      position: 0,
      createdAt: 40,
    });
    const legacyStatusId = await ctx.db.insert("listStatuses", {
      listId: legacyListId,
      name: "Open",
      color: "#000000",
      category: "open",
      position: 0,
      createdAt: 41,
    });
    const legacyTaskId = await ctx.db.insert("tasks", {
      listId: legacyListId,
      title: "Migrate legacy plan",
      statusId: legacyStatusId,
      assigneeClerkIds: [],
      createdByClerkId: OWNER.subject,
      position: 0,
      createdAt: 42,
    });
    const agentId = await ctx.db.insert("agents", {
      name: "Operator",
      parentType: "workspace",
      parentId: workspaceId,
      status: "active",
      createdByClerkId: OWNER.subject,
      createdAt: 50,
    });
    await ctx.db.insert("agentRuns", {
      agentId,
      taskId,
      title: "Launch check",
      status: "succeeded",
      startedAt: 60,
      finishedAt: 61,
    });
    return {
      workspaceId,
      otherWorkspaceId,
      spaceId,
      secondSpaceId,
      foreignSpaceId,
      projectId,
      listId,
      taskId,
      legacyFolderId,
      legacyListId,
      legacyTaskId,
      agentId,
    };
  });
  await t.mutation(api.oauth.registerClient, {
    clientId: CLIENT_ID,
    clientName: "Company OS",
    redirectUris: [REDIRECT_URI],
    registrationSubject: "companyos-test-client",
  });
  return {
    t,
    owner: t.withIdentity(OWNER),
    member: t.withIdentity(MEMBER),
    ...ids,
  };
}

async function grant(
  setupResult: Awaited<ReturnType<typeof setup>>,
  scope = "companyos:account:read companyos:data:read",
  suffix = "default",
) {
  const code = `opc_companyos_code_${suffix}`;
  const accessToken = `opa_companyos_access_${suffix}`;
  const refreshToken = `opr_companyos_refresh_${suffix}`;
  await setupResult.owner.mutation(api.oauth.approveAuthorization, {
    clientId: CLIENT_ID,
    redirectUri: REDIRECT_URI,
    scope,
    resource: RESOURCE,
    codeChallenge: CHALLENGE,
    codeHash: credentialHash(code),
    workspaceId: setupResult.workspaceId,
  });
  const response = await setupResult.t.fetch("/oauth/internal/token", {
    method: "POST",
    headers: {
      Authorization: `PKCE ${VERIFIER}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      operation: "authorization_code",
      codeHash: credentialHash(code),
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      accessTokenHash: credentialHash(accessToken),
      refreshTokenHash: credentialHash(refreshToken),
      resource: RESOURCE,
    }),
  });
  if (!response.ok) {
    const result = (await response.json()) as { error_description?: string };
    throw new Error(result.error_description ?? "Token grant failed");
  }
  return { accessToken, refreshToken };
}

async function backend<T>(
  state: Awaited<ReturnType<typeof setup>>,
  accessToken: string,
  operation: string,
  input: Record<string, unknown> = {},
): Promise<T> {
  const response = await state.t.fetch("/companyos/internal", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ operation, resource: RESOURCE, ...input }),
  });
  const value = (await response.json()) as {
    error_description?: string;
  };
  if (!response.ok) {
    throw new Error(value.error_description ?? "Connector backend failed");
  }
  return value as T;
}

describe("Company OS Connect v1 provider contract", () => {
  it("separates Company OS scopes and workspace consent from MCP agent authority", async () => {
    const state = await setup();
    const request = await state.owner.query(api.oauth.authorizationRequest, {
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      scope: "companyos:data:read",
      resource: RESOURCE,
      codeChallenge: CHALLENGE,
      codeChallengeMethod: "S256",
    });
    expect(request).toMatchObject({
      authorizationKind: "companyos",
      scopes: ["companyos:account:read", "companyos:data:read"],
      agents: [],
      workspaces: [
        {
          workspaceId: state.workspaceId,
          name: "Acme Operations",
          role: "owner",
        },
      ],
    });
    await expect(
      state.owner.query(api.oauth.authorizationRequest, {
        clientId: CLIENT_ID,
        redirectUri: REDIRECT_URI,
        scope: "operate:read companyos:data:read",
        resource: RESOURCE,
        codeChallenge: CHALLENGE,
        codeChallengeMethod: "S256",
      }),
    ).rejects.toThrow(/scopes do not match/i);
    await expect(
      state.owner.query(api.oauth.authorizationRequest, {
        clientId: CLIENT_ID,
        redirectUri: REDIRECT_URI,
        scope: "companyos:account:read",
        resource: MCP_RESOURCE,
        codeChallenge: CHALLENGE,
        codeChallengeMethod: "S256",
      }),
    ).rejects.toThrow(/scopes do not match/i);
  });

  it("requires PKCE and enforces account and data scopes independently", async () => {
    const state = await setup();
    const code = "opc_companyos_pkce";
    await state.owner.mutation(api.oauth.approveAuthorization, {
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      scope: "companyos:account:read",
      resource: RESOURCE,
      codeChallenge: CHALLENGE,
      codeHash: credentialHash(code),
      workspaceId: state.workspaceId,
    });
    const wrongPkce = await state.t.fetch("/oauth/internal/token", {
      method: "POST",
      headers: {
        Authorization: `PKCE ${"wrong-verifier".repeat(4)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        operation: "authorization_code",
        codeHash: credentialHash(code),
        clientId: CLIENT_ID,
        redirectUri: REDIRECT_URI,
        accessTokenHash: credentialHash("opa_wrong_pkce"),
        refreshTokenHash: credentialHash("opr_wrong_pkce"),
        resource: RESOURCE,
      }),
    });
    expect(wrongPkce.status).toBe(400);
    const tokens = await grant(state, "companyos:account:read", "account");
    const storedToken = await state.t.run(async (ctx) =>
      ctx.db
        .query("oauthAccessTokens")
        .withIndex("by_token_hash", (q) =>
          q.eq("tokenHash", credentialHash(tokens.accessToken)),
        )
        .unique(),
    );
    expect(storedToken).toMatchObject({
      tokenHash: credentialHash(tokens.accessToken),
      refreshTokenHash: credentialHash(tokens.refreshToken),
    });
    expect(JSON.stringify(storedToken)).not.toContain(tokens.accessToken);
    expect(JSON.stringify(storedToken)).not.toContain(tokens.refreshToken);
    await expect(
      backend<ConnectorAccount>(state, tokens.accessToken, "account"),
    ).resolves.toMatchObject({
      providerId: "operate",
      subject: OWNER.subject,
      workspace: { externalId: `operate:workspace:${state.workspaceId}` },
    });
    await expect(
      backend<ConnectorSnapshot>(state, tokens.accessToken, "snapshot", {
        objectType: "workspace",
        paginationOpts: { numItems: 1, cursor: null },
      }),
    ).rejects.toThrow(/missing the required scope/i);
    await expect(
      backend<ConnectorInstallation>(
        state,
        tokens.accessToken,
        "installation.upsert",
        { externalInstallationId: "companyos_account_only" },
      ),
    ).rejects.toThrow(/missing the required scope/i);
  });

  it("paginates deterministically and refuses cross-tenant parents", async () => {
    const state = await setup();
    const { accessToken } = await grant(state);
    await backend<ConnectorInstallation>(
      state,
      accessToken,
      "installation.upsert",
      { externalInstallationId: "companyos_installation_pagination" },
    );
    const first = await backend<ConnectorSnapshot>(state, accessToken, "snapshot", {
      objectType: "space",
      paginationOpts: { numItems: 1, cursor: null },
    });
    expect(first.page).toHaveLength(1);
    expect(first.isDone).toBe(false);
    const second = await backend<ConnectorSnapshot>(state, accessToken, "snapshot", {
      objectType: "space",
      paginationOpts: { numItems: 1, cursor: first.continueCursor },
    });
    const ids = [...first.page, ...second.page].map((object) => object.externalId);
    expect(ids).toEqual([
      `operate:space:${state.spaceId}`,
      `operate:space:${state.secondSpaceId}`,
    ]);
    expect(ids).not.toContain(`operate:space:${state.foreignSpaceId}`);
    await expect(
      backend<ConnectorSnapshot>(state, accessToken, "snapshot", {
        objectType: "project",
        parentType: "space",
        parentId: state.foreignSpaceId,
        paginationOpts: { numItems: 10, cursor: null },
      }),
    ).rejects.toThrow(/requested object was not found/i);
    const tasks = await backend<ConnectorSnapshot>(state, accessToken, "snapshot", {
      objectType: "task",
      parentType: "list",
      parentId: state.listId,
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(tasks.page).toMatchObject([
      {
        objectType: "task",
        externalId: `operate:task:${state.taskId}`,
        data: { title: "Prepare launch" },
      },
    ]);
    expect(tasks.page[0]?.updatedAt).toEqual(expect.any(Number));
    const firstTaskVersion = tasks.page[0]?.version;
    const firstTaskUpdatedAt = tasks.page[0]?.updatedAt;
    const unchangedTasks = await backend<ConnectorSnapshot>(
      state,
      accessToken,
      "snapshot",
      {
        objectType: "task",
        parentType: "list",
        parentId: state.listId,
        paginationOpts: { numItems: 10, cursor: null },
      },
    );
    expect(unchangedTasks.page[0]?.updatedAt).toBe(firstTaskUpdatedAt);
    await state.t.run(async (ctx) => {
      await ctx.db.patch(state.taskId, { title: "Prepare final launch" });
    });
    const changedTasks = await backend<ConnectorSnapshot>(
      state,
      accessToken,
      "snapshot",
      {
        objectType: "task",
        parentType: "list",
        parentId: state.listId,
        paginationOpts: { numItems: 10, cursor: null },
      },
    );
    expect(changedTasks.page[0]?.version).not.toBe(firstTaskVersion);
    expect(changedTasks.page[0]!.updatedAt).toBeGreaterThan(
      firstTaskUpdatedAt!,
    );
    const legacyProjects = await backend<ConnectorSnapshot>(
      state,
      accessToken,
      "snapshot",
      {
        objectType: "project",
        parentType: "space",
        parentId: state.spaceId,
        legacy: true,
        paginationOpts: { numItems: 10, cursor: null },
      },
    );
    expect(legacyProjects.page).toMatchObject([
      {
        objectType: "project",
        externalId: `operate:project:${state.legacyFolderId}`,
        data: { legacy_folder: true },
      },
    ]);
    const legacyLists = await backend<ConnectorSnapshot>(
      state,
      accessToken,
      "snapshot",
      {
        objectType: "list",
        parentType: "folder",
        parentId: state.legacyFolderId,
        paginationOpts: { numItems: 10, cursor: null },
      },
    );
    expect(legacyLists.page).toMatchObject([
      {
        externalId: `operate:list:${state.legacyListId}`,
        data: {
          parent_external_id: `operate:project:${state.legacyFolderId}`,
        },
      },
    ]);
    const legacyTasks = await backend<ConnectorSnapshot>(
      state,
      accessToken,
      "snapshot",
      {
        objectType: "task",
        parentType: "list",
        parentId: state.legacyListId,
        paginationOpts: { numItems: 10, cursor: null },
      },
    );
    expect(legacyTasks.page[0]?.externalId).toBe(
      `operate:task:${state.legacyTaskId}`,
    );
  });

  it("rechecks role authority and revocation disconnects the durable binding", async () => {
    const state = await setup();
    const tokens = await grant(state);
    const installation = await backend<ConnectorInstallation>(
      state,
      tokens.accessToken,
      "installation.upsert",
      {
        externalInstallationId: "companyos_installation_acme",
      },
    );
    expect(installation.status).toBe("active");
    const staleParallelGrant = await grant(
      state,
      undefined,
      "stale-parallel",
    );
    const delayedCode = "opc_companyos_code_delayed";
    await state.owner.mutation(api.oauth.approveAuthorization, {
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      scope: "companyos:account:read companyos:data:read",
      resource: RESOURCE,
      codeChallenge: CHALLENGE,
      codeHash: credentialHash(delayedCode),
      workspaceId: state.workspaceId,
    });
    await state.t.run(async (ctx) => {
      const stale = await ctx.db
        .query("oauthAccessTokens")
        .withIndex("by_token_hash", (q) =>
          q.eq("tokenHash", credentialHash(staleParallelGrant.accessToken)),
        )
        .unique();
      await ctx.db.patch(stale!._id, { createdAt: 1 });
    });
    await state.t.mutation(api.oauth.revokeToken, {
      tokenHash: credentialHash(tokens.refreshToken),
    });
    await expect(
      backend<ConnectorAccount>(state, tokens.accessToken, "account"),
    ).rejects.toThrow(/invalid or no longer authorized/i);
    const row = await state.t.run(async (ctx) =>
      ctx.db
        .query("companyOsInstallations")
        .withIndex("by_external_installation_id", (q) =>
          q.eq("externalInstallationId", "companyos_installation_acme"),
        )
        .unique(),
    );
    expect(row).toMatchObject({
      status: "disconnected",
      externalInstallationId: "companyos_installation_acme",
    });
    const delayedExchange = await state.t.fetch("/oauth/internal/token", {
      method: "POST",
      headers: {
        Authorization: `PKCE ${VERIFIER}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        operation: "authorization_code",
        codeHash: credentialHash(delayedCode),
        clientId: CLIENT_ID,
        redirectUri: REDIRECT_URI,
        accessTokenHash: credentialHash("opa_delayed"),
        refreshTokenHash: credentialHash("opr_delayed"),
        resource: RESOURCE,
      }),
    });
    expect(delayedExchange.status).toBe(400);
    const staleRefresh = await state.t.fetch("/oauth/internal/token", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${staleParallelGrant.refreshToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        operation: "refresh_token",
        clientId: CLIENT_ID,
        accessTokenHash: credentialHash("opa_stale_refresh"),
        nextRefreshTokenHash: credentialHash("opr_stale_refresh"),
        resource: RESOURCE,
      }),
    });
    await expect(staleRefresh.json()).resolves.toMatchObject({
      ok: false,
      replayDetected: true,
    });
    await expect(
      backend<ConnectorInstallation>(
        state,
        staleParallelGrant.accessToken,
        "installation.upsert",
        { externalInstallationId: "companyos_installation_acme" },
      ),
    ).rejects.toThrow(/invalid or no longer authorized/i);
    await expect(
      backend<ConnectorInstallation>(
        state,
        staleParallelGrant.accessToken,
        "installation.upsert",
        { externalInstallationId: "companyos_installation_alternate" },
      ),
    ).rejects.toThrow(/invalid or no longer authorized/i);

    const fresh = await grant(state, undefined, "downgrade");
    await expect(
      backend<ConnectorSnapshot>(state, fresh.accessToken, "snapshot", {
        objectType: "workspace",
        paginationOpts: { numItems: 1, cursor: null },
      }),
    ).rejects.toThrow(/invalid or no longer authorized/i);
    await state.t.run(async (ctx) => {
      const [binding, token] = await Promise.all([
        ctx.db
          .query("companyOsInstallations")
          .withIndex("by_external_installation_id", (q) =>
            q.eq("externalInstallationId", "companyos_installation_acme"),
          )
          .unique(),
        ctx.db
          .query("oauthAccessTokens")
          .withIndex("by_token_hash", (q) =>
            q.eq("tokenHash", credentialHash(fresh.accessToken)),
          )
          .unique(),
      ]);
      await ctx.db.patch(token!._id, {
        createdAt: binding!.disconnectedAt! + 1,
      });
    });
    await expect(
      backend<ConnectorInstallation>(
        state,
        fresh.accessToken,
        "installation.upsert",
        { externalInstallationId: "companyos_installation_alternate" },
      ),
    ).rejects.toThrow(/different installation identity/i);
    await expect(
      backend<ConnectorInstallation>(
        state,
        fresh.accessToken,
        "installation.upsert",
        { externalInstallationId: "companyos_installation_acme" },
      ),
    ).resolves.toMatchObject({ status: "active" });
    await expect(
      backend<ConnectorSnapshot>(state, fresh.accessToken, "snapshot", {
        objectType: "workspace",
        paginationOpts: { numItems: 1, cursor: null },
      }),
    ).resolves.toMatchObject({ page: [{ objectType: "workspace" }] });
    // Cleanup of the losing/stale grant is exact-grant-bound and cannot tear
    // down the fresh winner now stored on the same installation identity.
    await state.t.mutation(api.oauth.revokeToken, {
      tokenHash: credentialHash(tokens.accessToken),
    });
    await expect(
      backend(state, tokens.accessToken, "installation.disconnect", {
        externalInstallationId: "companyos_installation_acme",
      }),
    ).rejects.toThrow(/invalid or no longer authorized/i);
    await expect(
      backend<ConnectorSnapshot>(state, fresh.accessToken, "snapshot", {
        objectType: "workspace",
        paginationOpts: { numItems: 1, cursor: null },
      }),
    ).resolves.toMatchObject({ page: [{ objectType: "workspace" }] });
    await state.t.run(async (ctx) => {
      const membership = await ctx.db
        .query("memberships")
        .withIndex("by_user_and_workspace", (q) =>
          q
            .eq("userClerkId", OWNER.subject)
            .eq("workspaceId", state.workspaceId),
        )
        .unique();
      await ctx.db.patch(membership!._id, { role: "member" });
    });
    await expect(
      backend<ConnectorAccount>(state, fresh.accessToken, "account"),
    ).rejects.toThrow(/invalid or no longer authorized/i);
  });

  it("fails closed when the OAuth subject no longer has an active user record", async () => {
    const state = await setup();
    const { accessToken } = await grant(state, undefined, "deleted-user");
    await state.t.run(async (ctx) => {
      const user = await ctx.db
        .query("users")
        .withIndex("by_clerk_id", (q) => q.eq("clerkId", OWNER.subject))
        .unique();
      await ctx.db.delete(user!._id);
    });
    await expect(
      backend<ConnectorAccount>(state, accessToken, "account"),
    ).rejects.toThrow(/invalid or no longer authorized/i);
  });
});
