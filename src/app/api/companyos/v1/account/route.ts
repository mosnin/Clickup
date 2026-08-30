import {
  bearerAccessToken,
  companyOsBackend,
  companyOsAuthError,
  companyOsJson,
  companyOsRouteError,
  type ConnectorAccount,
} from "@/lib/companyos-connect";
import { companyOsOAuthResource } from "@/lib/oauth-server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: Request) {
  const accessToken = bearerAccessToken(request);
  if (!accessToken) {
    return companyOsAuthError("A Bearer access token is required");
  }
  try {
    const account = await companyOsBackend<ConnectorAccount>(
      "account",
      accessToken,
      { resource: companyOsOAuthResource() },
    );
    return companyOsJson({
      subject: { id: account.subject },
      tenant: {
        id: account.workspace.externalId,
        label: account.workspace.name,
      },
      roles: [account.workspace.role],
    });
  } catch (error) {
    return companyOsRouteError(error);
  }
}
