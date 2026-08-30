import { convexHttpActionOrigin } from "./oauth-server";

export const COMPANY_OS_PROTOCOL_VERSION = 1 as const;
export const COMPANY_OS_OBJECT_TYPES = [
  "workspace",
  "space",
  "project",
  "list",
  "task",
  "agent",
  "run",
] as const;

export type CompanyOsObjectType = (typeof COMPANY_OS_OBJECT_TYPES)[number];
export type CompanyOsParentType =
  | "space"
  | "project"
  | "folder"
  | "list"
  | "agent";

export type ConnectorAccount = {
  providerId: "operate";
  subject: string;
  oauthClientId: string;
  scopes: string[];
  workspace: {
    externalId: string;
    name: string;
    slug: string;
    role: "owner" | "admin";
    sourcePath: string;
  };
};

export type ConnectorSnapshotObject = {
  objectType: CompanyOsObjectType;
  externalId: string;
  version: string;
  updatedAt: number;
  sourcePath: string;
  data: Record<string, unknown>;
};

export type ConnectorSnapshot = {
  page: ConnectorSnapshotObject[];
  isDone: boolean;
  continueCursor: string;
};

export type ConnectorInstallation = {
  externalInstallationId: string;
  workspaceId: string;
  oauthSubject: string;
  oauthClientId: string;
  scopes: string[];
  status: "active" | "disconnected";
  installedAt: number;
  updatedAt: number;
  disconnectedAt?: number;
};

export async function companyOsBackend<T>(
  operation: string,
  accessToken: string,
  input: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(`${convexHttpActionOrigin()}/companyos/internal`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ operation, ...input }),
    cache: "no-store",
  });
  const value = (await response.json().catch(() => null)) as {
    error_description?: unknown;
  } | null;
  if (!response.ok) {
    throw new Error(
      typeof value?.error_description === "string"
        ? value.error_description
        : "Connector backend request failed",
    );
  }
  return value as T;
}

export function bearerAccessToken(request: Request) {
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([^\s]+)$/i.exec(authorization);
  return match?.[1] ?? null;
}

export function companyOsJson(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      Pragma: "no-cache",
    },
  });
}

export function companyOsAuthError(description: string, status = 401) {
  const safe = description.replaceAll('"', "'");
  return new Response(
    JSON.stringify({ error: status === 403 ? "insufficient_scope" : "invalid_token", error_description: description }),
    {
      status,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        Pragma: "no-cache",
        "WWW-Authenticate": `Bearer error="${status === 403 ? "insufficient_scope" : "invalid_token"}", error_description="${safe}"`,
      },
    },
  );
}

export function companyOsRouteError(error: unknown) {
  const message = error instanceof Error ? error.message : "Connector request failed";
  if (/missing required scope|insufficient/i.test(message)) {
    return companyOsAuthError("The access token is missing the required scope", 403);
  }
  if (/access token|no longer authorized/i.test(message)) {
    return companyOsAuthError("The access token is invalid or no longer authorized");
  }
  if (/outside the authorized workspace/i.test(message)) {
    return companyOsJson({ error: "not_found", error_description: "The requested object was not found" }, 404);
  }
  if (
    /required|invalid format|page size|do not accept|use the authorized|already bound|installation identity|active installation/i.test(
      message,
    )
  ) {
    return companyOsJson({ error: "invalid_request", error_description: message }, 400);
  }
  return companyOsJson(
    { error: "server_error", error_description: "Connector request failed" },
    500,
  );
}
