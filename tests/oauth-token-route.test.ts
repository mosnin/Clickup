import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";

// The token and revocation endpoints from the outside, over real HTTP
// objects and real Convex functions.
//
// The mutations have their own tests; what only this file can prove is the
// wire answer, which is the part a client actually codes against: a replayed
// credential has to come back as HTTP 400 with `invalid_grant`, and a
// disconnect has to come back as 200 no matter what it was handed. A test of
// the mutation alone would pass while the route answered 500.

const modules = import.meta.glob("../convex/**/*.*s");

// Set inside each test's setup and read lazily by the mock below, because
// the route resolves its client per call rather than at import time.
let backend: ReturnType<typeof convexTest> | null = null;

vi.mock("@/lib/oauth-server", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/lib/oauth-server")>();
  return {
    ...actual,
    // The real one needs a deployment URL and a network. Everything else in
    // the module, including the error and JSON helpers whose headers this
    // file asserts on, stays exactly as shipped.
    oauthConvexClient: () => ({
      query: (reference: unknown, args: unknown) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        backend!.query(reference as any, args as any),
      mutation: (reference: unknown, args: unknown) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        backend!.mutation(reference as any, args as any),
    }),
  };
});

const { POST: token } = await import("../src/app/oauth/token/route");
const { POST: revoke } = await import("../src/app/oauth/revoke/route");

const OWNER = { subject: "route_owner", email: "owner@example.com" };
const CLIENT_ID = "opc_route_client";
const REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";
const RESOURCE = "https://operate.to/api/mcp";
const VERIFIER = "v".repeat(64);
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");

function form(fields: Record<string, string>) {
  return new Request("https://operate.to/oauth/token", {
    method: "POST",
    body: new URLSearchParams(fields),
  });
}

async function seed(code: string) {
  process.env.NEXT_PUBLIC_APP_URL = "https://operate.to";
  const t = convexTest(schema, modules);
  backend = t;
  const agentId = await t.run(async (ctx) => {
    const workspaceId = await ctx.db.insert("workspaces", {
      name: "Route QA",
      slug: "route-qa",
      ownerClerkId: OWNER.subject,
      createdAt: Date.now(),
    });
    await ctx.db.insert("memberships", {
      workspaceId,
      userClerkId: OWNER.subject,
      role: "owner",
      joinedAt: Date.now(),
    });
    return ctx.db.insert("agents", {
      name: "Route Agent",
      parentType: "workspace",
      parentId: workspaceId,
      status: "active",
      role: "member",
      createdByClerkId: OWNER.subject,
      createdAt: Date.now(),
    });
  });
  await t.mutation(api.oauth.registerClient, {
    clientId: CLIENT_ID,
    clientName: "Claude",
    redirectUris: [REDIRECT_URI],
    registrationSubject: "route-client",
  });
  await t.withIdentity(OWNER).mutation(api.oauth.approveAuthorization, {
    clientId: CLIENT_ID,
    redirectUri: REDIRECT_URI,
    scope: "operate:read operate:write",
    resource: RESOURCE,
    codeChallenge: CHALLENGE,
    codeChallengeMethod: "S256",
    code,
    agentId,
  });
  return t;
}

function exchange(code: string) {
  return token(
    form({
      grant_type: "authorization_code",
      code,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_verifier: VERIFIER,
      resource: RESOURCE,
    }),
  );
}

beforeEach(() => {
  backend = null;
});

describe("POST /oauth/token", () => {
  it("answers the standard success body, and never caches it", async () => {
    await seed("opc_route_success");
    const response = await exchange("opc_route_success");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body).toMatchObject({
      token_type: "Bearer",
      expires_in: 3600,
      scope: "operate:read operate:write",
    });
    expect(body.access_token).toEqual(expect.any(String));
    expect(body.refresh_token).toEqual(expect.any(String));
    expect(body.refresh_token).not.toBe(body.access_token);
    expect(body.expires_in).toBeLessThanOrEqual(86400);
  });

  it("answers a replayed authorization code with 400 invalid_grant", async () => {
    await seed("opc_route_replay");
    const first = await exchange("opc_route_replay");
    expect(first.status).toBe(200);

    const second = await exchange("opc_route_replay");
    expect(second.status).toBe(400);
    const body = await second.json();
    expect(body.error).toBe("invalid_grant");

    // And the answer is true: the token the first exchange handed out is
    // dead, not merely the second attempt refused.
    const issued = await first.json();
    await expect(
      backend!.query(api.agentApi.whoami, { apiKey: issued.access_token }),
    ).rejects.toThrow(/invalid api key/i);
  });

  it("rotates on refresh and answers a reused refresh token with 400 invalid_grant", async () => {
    await seed("opc_route_refresh");
    const issued = await (await exchange("opc_route_refresh")).json();

    const refreshed = await token(
      form({
        grant_type: "refresh_token",
        refresh_token: issued.refresh_token,
        client_id: CLIENT_ID,
        resource: RESOURCE,
      }),
    );
    expect(refreshed.status).toBe(200);
    const rotated = await refreshed.json();
    expect(rotated.refresh_token).not.toBe(issued.refresh_token);
    expect(rotated.access_token).not.toBe(issued.access_token);

    const replayed = await token(
      form({
        grant_type: "refresh_token",
        refresh_token: issued.refresh_token,
        client_id: CLIENT_ID,
        resource: RESOURCE,
      }),
    );
    expect(replayed.status).toBe(400);
    expect((await replayed.json()).error).toBe("invalid_grant");
    await expect(
      backend!.query(api.agentApi.whoami, { apiKey: rotated.access_token }),
    ).rejects.toThrow(/invalid api key/i);
  });

  it("refuses a mismatched PKCE verifier without touching the grant", async () => {
    await seed("opc_route_pkce");
    const refused = await token(
      form({
        grant_type: "authorization_code",
        code: "opc_route_pkce",
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        code_verifier: "w".repeat(64),
        resource: RESOURCE,
      }),
    );
    expect(refused.status).toBe(400);
    expect((await refused.json()).error).toBe("invalid_grant");
    // A wrong verifier is a failure, not a theft signal, so the code is
    // still there for the client that holds the real one.
    expect((await exchange("opc_route_pkce")).status).toBe(200);
  });
});

describe("POST /oauth/revoke", () => {
  it("answers 200 with an empty body for a token that never existed", async () => {
    await seed("opc_route_revoke_unknown");
    const response = await revoke(
      new Request("https://operate.to/oauth/revoke", {
        method: "POST",
        body: new URLSearchParams({
          client_id: CLIENT_ID,
          token: "opa_never_issued",
        }),
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
  });

  it("answers 200 even for a body it cannot parse", async () => {
    await seed("opc_route_revoke_garbage");
    const response = await revoke(
      new Request("https://operate.to/oauth/revoke", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      }),
    );
    // RFC 7009 has no failure mode a disconnecting client could act on, and
    // one that retries forever is worse than one that moves on.
    expect(response.status).toBe(200);
  });

  it("kills the access token when handed the refresh token", async () => {
    await seed("opc_route_revoke");
    const issued = await (await exchange("opc_route_revoke")).json();
    const response = await revoke(
      new Request("https://operate.to/oauth/revoke", {
        method: "POST",
        body: new URLSearchParams({
          client_id: CLIENT_ID,
          token: issued.refresh_token,
        }),
      }),
    );
    expect(response.status).toBe(200);
    await expect(
      backend!.query(api.agentApi.whoami, { apiKey: issued.access_token }),
    ).rejects.toThrow(/invalid api key/i);
  });
});
