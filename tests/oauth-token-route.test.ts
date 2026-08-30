import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../src/app/oauth/token/route";

const ISSUER = "https://www.operate.to";
const RESOURCE = `${ISSUER}/api/companyos`;

function tokenRequest(fields: Record<string, string>) {
  return new Request(`${ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });
}

function backendCall(fetchMock: ReturnType<typeof vi.fn>) {
  const [url, init] = fetchMock.mock.calls[0] as unknown as [
    string,
    RequestInit,
  ];
  return {
    url,
    authorization: new Headers(init.headers).get("authorization"),
    body: JSON.parse(String(init.body)) as Record<string, unknown>,
  };
}

describe("OAuth token recovery responses", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", ISSUER);
    vi.stubEnv("CONVEX_SITE_URL", "https://example.convex.site");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("maps exact authorization-code replay cleanup to a machine-verifiable response", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        ok: false,
        replayDetected: true,
        grantRevoked: true,
        recoveryStatus: "authorization_code_replay_revoked",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const rawCode = "opc_consumed_code";
    const verifier = "v".repeat(64);

    const response = await POST(
      tokenRequest({
        grant_type: "authorization_code",
        client_id: "companyos_client",
        code: rawCode,
        redirect_uri: "https://companyos.sh/api/connect/callback",
        code_verifier: verifier,
        resource: RESOURCE,
      }),
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      error: "invalid_grant",
      error_description:
        "Authorization code was already consumed; the issued grant family was revoked",
      grant_revoked: true,
      recovery_status: "authorization_code_replay_revoked",
    });
    const backend = backendCall(fetchMock);
    expect(backend.url).toBe(
      "https://example.convex.site/oauth/internal/token",
    );
    expect(backend.authorization).toBe(`PKCE ${verifier}`);
    expect(backend.body).toMatchObject({
      operation: "authorization_code",
      codeHash: createHash("sha256").update(rawCode).digest("hex"),
      clientId: "companyos_client",
      resource: RESOURCE,
    });
    expect(JSON.stringify(backend.body)).not.toContain(rawCode);
  });

  it("maps exact rotated-refresh replay cleanup and echoes stored scopes", async () => {
    const storedScope = "companyos:account:read companyos:data:read";
    const fetchMock = vi.fn(async () =>
      Response.json({
        ok: false,
        replayDetected: true,
        grantRevoked: true,
        recoveryStatus: "refresh_token_replay_revoked",
        scope: storedScope,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const oldRefreshToken = "opr_consumed_refresh";

    const response = await POST(
      tokenRequest({
        grant_type: "refresh_token",
        client_id: "companyos_client",
        refresh_token: oldRefreshToken,
        resource: RESOURCE,
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_grant",
      error_description:
        "Refresh token replay detected; the authorization grant was revoked",
      grant_revoked: true,
      recovery_status: "refresh_token_replay_revoked",
      scope: storedScope,
    });
    const backend = backendCall(fetchMock);
    expect(backend.authorization).toBe(`Bearer ${oldRefreshToken}`);
    expect(backend.body).toMatchObject({
      operation: "refresh_token",
      clientId: "companyos_client",
      resource: RESOURCE,
    });
    expect(JSON.stringify(backend.body)).not.toContain(oldRefreshToken);
  });

  it("does not turn an ordinary invalid_grant into a cleanup receipt", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json(
        { error: "invalid_grant", error_description: "Token grant failed" },
        { status: 400 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(
      tokenRequest({
        grant_type: "refresh_token",
        client_id: "wrong_client",
        refresh_token: "opr_wrong_metadata",
        resource: RESOURCE,
      }),
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(400);
    expect(body).toEqual({
      error: "invalid_grant",
      error_description: "Token grant failed",
    });
    expect(body).not.toHaveProperty("grant_revoked");
    expect(body).not.toHaveProperty("recovery_status");
  });

  it("does not promote an unverified backend replay result into a cleanup receipt", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ ok: false, replayDetected: true }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(
      tokenRequest({
        grant_type: "refresh_token",
        client_id: "companyos_client",
        refresh_token: "opr_legacy_or_cutoff_replay",
        resource: RESOURCE,
      }),
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(400);
    expect(body).toEqual({
      error: "invalid_grant",
      error_description: "Token grant failed",
    });
    expect(body).not.toHaveProperty("grant_revoked");
    expect(body).not.toHaveProperty("recovery_status");
  });
});
