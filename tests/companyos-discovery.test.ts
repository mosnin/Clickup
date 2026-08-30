import { beforeEach, describe, expect, it } from "vitest";
import { GET as getConnectorDiscovery } from "../src/app/.well-known/companyos-connector/route";
import { GET as getConnectorProtectedResource } from "../src/app/.well-known/oauth-protected-resource/api/companyos/route";
import {
  decodeCompanyOsSnapshotCursor,
  encodeCompanyOsSnapshotCursor,
  initialCompanyOsSnapshotCursor,
} from "../src/lib/companyos-snapshot-cursor";

describe("Company OS Connect public discovery", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = "https://operate.to";
    process.env.COMPANYOS_CURSOR_SECRET = "c".repeat(32);
  });

  it("publishes the canonical v1 endpoints, audience, scopes, and bounds", async () => {
    const response = getConnectorDiscovery();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({
      protocolVersion: "1",
      provider: "operate",
      issuer: "https://www.operate.to",
      authorizationEndpoint: "https://www.operate.to/oauth/authorize",
      tokenEndpoint: "https://www.operate.to/oauth/token",
      revocationEndpoint: "https://www.operate.to/oauth/revoke",
      accountEndpoint: "https://www.operate.to/api/companyos/v1/account",
      snapshotEndpoint: "https://www.operate.to/api/companyos/v1/snapshot",
      resource: "https://www.operate.to/api/companyos",
      scopes: ["companyos:account:read", "companyos:data:read"],
      objectTypes: [
        "workspace",
        "space",
        "project",
        "list",
        "task",
        "agent",
        "run",
      ],
      pagination: {
        maximumPageSize: 200,
        checkpoint: "full_snapshot_mark_and_sweep",
      },
      objectVersioning: {
        version: "content_sha256",
        updatedAt: "provider_observed_version_change",
        deletions: "terminal_checkpoint_mark_and_sweep",
      },
      authorizationCodeRecovery: {
        replayBehavior: "revoke_issued_grant_family",
        responseStatus: 400,
        error: "invalid_grant",
        grantRevoked: true,
        recoveryStatus: "authorization_code_replay_revoked",
      },
      refreshTokenRecovery: {
        replayBehavior: "revoke_rotated_grant_family",
        responseStatus: 400,
        error: "invalid_grant",
        grantRevoked: true,
        recoveryStatus: "refresh_token_replay_revoked",
        scope: "stored_grant_scopes",
      },
    });

    const protectedResource = await getConnectorProtectedResource().json();
    expect(protectedResource).toMatchObject({
      resource: "https://www.operate.to/api/companyos",
      authorization_servers: ["https://www.operate.to"],
      scopes_supported: [
        "companyos:account:read",
        "companyos:data:read",
      ],
      bearer_methods_supported: ["header"],
    });
  });

  it("round-trips opaque traversal cursors and rejects malformed state", () => {
    const state = {
      ...initialCompanyOsSnapshotCursor(),
      phase: "project_tasks" as const,
      spaceCursor: "space_cursor",
      spaceId: "space_id",
      projectCursor: "project_cursor",
    };
    const encoded = encodeCompanyOsSnapshotCursor(state, "binding_a");
    expect(encoded).not.toContain("project_tasks");
    expect(decodeCompanyOsSnapshotCursor(encoded, "binding_a")).toEqual(state);
    expect(() => decodeCompanyOsSnapshotCursor(encoded, "binding_b")).toThrow(
      /cursor is invalid/i,
    );
    expect(() =>
      decodeCompanyOsSnapshotCursor("not-valid-json", "binding_a"),
    ).toThrow(
      /cursor is invalid/i,
    );
  });
});
