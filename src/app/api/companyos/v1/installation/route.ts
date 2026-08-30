import {
  bearerAccessToken,
  companyOsBackend,
  companyOsAuthError,
  companyOsJson,
  companyOsRouteError,
  type ConnectorInstallation,
} from "@/lib/companyos-connect";
import { companyOsOAuthResource } from "@/lib/oauth-server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function tokenOrResponse(request: Request) {
  const accessToken = bearerAccessToken(request);
  return accessToken ?? companyOsAuthError("A Bearer access token is required");
}

export async function GET(request: Request) {
  const token = tokenOrResponse(request);
  if (token instanceof Response) return token;
  try {
    const installation = await companyOsBackend<ConnectorInstallation | null>(
      "installation.get",
      token,
      { resource: companyOsOAuthResource() },
    );
    return companyOsJson(
      installation
        ? {
            externalInstallationId: installation.externalInstallationId,
            status: installation.status,
            installedAt: new Date(installation.installedAt).toISOString(),
            updatedAt: new Date(installation.updatedAt).toISOString(),
          }
        : null,
    );
  } catch (error) {
    return companyOsRouteError(error);
  }
}

export async function PUT(request: Request) {
  const token = tokenOrResponse(request);
  if (token instanceof Response) return token;
  let input: { externalInstallationId?: unknown };
  try {
    input = await request.json();
  } catch {
    return companyOsJson(
      { error: "invalid_request", error_description: "Body must be JSON" },
      400,
    );
  }
  if (typeof input.externalInstallationId !== "string") {
    return companyOsJson(
      {
        error: "invalid_request",
        error_description: "externalInstallationId is required",
      },
      400,
    );
  }
  try {
    const installation = await companyOsBackend<ConnectorInstallation>(
      "installation.upsert",
      token,
      {
        resource: companyOsOAuthResource(),
        externalInstallationId: input.externalInstallationId,
      },
    );
    return companyOsJson({
      externalInstallationId: installation.externalInstallationId,
      status: installation.status,
      installedAt: new Date(installation.installedAt).toISOString(),
      updatedAt: new Date(installation.updatedAt).toISOString(),
    });
  } catch (error) {
    return companyOsRouteError(error);
  }
}

export async function DELETE(request: Request) {
  const token = tokenOrResponse(request);
  if (token instanceof Response) return token;
  let externalInstallationId: string | undefined;
  if (request.headers.get("content-length") !== "0") {
    const input = (await request.json().catch(() => null)) as {
      externalInstallationId?: unknown;
    } | null;
    if (input?.externalInstallationId !== undefined) {
      if (typeof input.externalInstallationId !== "string") {
        return companyOsJson(
          {
            error: "invalid_request",
            error_description: "externalInstallationId must be a string",
          },
          400,
        );
      }
      externalInstallationId = input.externalInstallationId;
    }
  }
  try {
    const result = await companyOsBackend<{
      disconnected: boolean;
      tokenRevoked: boolean;
    }>(
      "installation.disconnect",
      token,
      {
        resource: companyOsOAuthResource(),
        ...(externalInstallationId ? { externalInstallationId } : {}),
      },
    );
    return companyOsJson(result);
  } catch (error) {
    return companyOsRouteError(error);
  }
}
