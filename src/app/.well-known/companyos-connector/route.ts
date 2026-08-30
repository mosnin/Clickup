import {
  companyOsOAuthResource,
  oauthIssuer,
} from "@/lib/oauth-server";
import {
  COMPANY_OS_OBJECT_TYPES,
  COMPANY_OS_PROTOCOL_VERSION,
  companyOsJson,
} from "@/lib/companyos-connect";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export function GET() {
  const issuer = oauthIssuer();
  return companyOsJson({
    protocolVersion: String(COMPANY_OS_PROTOCOL_VERSION),
    provider: "operate",
    issuer,
    authorizationEndpoint: `${issuer}/oauth/authorize`,
    tokenEndpoint: `${issuer}/oauth/token`,
    revocationEndpoint: `${issuer}/oauth/revoke`,
    accountEndpoint: `${issuer}/api/companyos/v1/account`,
    snapshotEndpoint: `${issuer}/api/companyos/v1/snapshot`,
    installationEndpoint: `${issuer}/api/companyos/v1/installation`,
    resource: companyOsOAuthResource(),
    scopes: ["companyos:account:read", "companyos:data:read"],
    objectTypes: [...COMPANY_OS_OBJECT_TYPES],
    pagination: {
      cursor: "opaque",
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
}
