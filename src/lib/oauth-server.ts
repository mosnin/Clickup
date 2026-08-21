import { randomBytes } from "node:crypto";
import { ConvexHttpClient } from "convex/browser";
import {
  CANONICAL_PRODUCTION_MCP_RESOURCE,
  discoveryIssuer,
  servingMcpUrl,
  servingOrigin,
  validateMcpResource,
} from "./oauth-resource";
import {
  oauthCorsHeaders,
  oauthFieldAliases,
  oauthOptions,
  parseJsonBody,
  canonicalOAuthKey,
  extractOperateCredential,
} from "./oauth-slash";

export { servingMcpUrl, servingOrigin };
export { oauthCorsHeaders, oauthOptions };

// RFC 8628 §3.4. Lives here rather than beside the handler that reads it,
// because a Next route file may only export HTTP handlers and the documented
// config values — an extra export fails the build.
export const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

// The state Convex reports → the error code RFC 8628 §3.5 defines.
//
// Pure, and separated from the handler, because this mapping is the entire
// contract a polling agent codes against: every agent runtime that already
// speaks the device grant branches on these exact strings, so getting one
// wrong turns a working connection into a runtime that gives up or spins.
// Returning `null` means "not an error" — the key is issued.
export type DeviceClaimState =
  | "pending"
  | "approved"
  | "denied"
  | "claimed"
  | "expired"
  | "not_found";

export function deviceErrorCode(
  state: DeviceClaimState,
  slowDown = false,
): string | null {
  switch (state) {
    case "approved":
      return null;
    // slow_down is not advice: by the time it is returned, the interval the
    // client must respect has already grown server-side.
    case "pending":
      return slowDown ? "slow_down" : "authorization_pending";
    case "denied":
      return "access_denied";
    case "expired":
      return "expired_token";
    // A replayed device code gets invalid_grant rather than a second key,
    // and an unknown one is answered identically so nobody can probe for
    // live codes.
    case "claimed":
    case "not_found":
      return "invalid_grant";
  }
}

export function oauthIssuer(request?: Request) {
  return discoveryIssuer(
    request?.url,
    process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, ""),
  );
}

/**
 * RFC 9728 inserts `/.well-known/oauth-protected-resource` between host
 * and path. The audience is `https://operate.to/api/mcp`, so clients that
 * construct metadata (instead of following WWW-Authenticate) GET
 * `/.well-known/oauth-protected-resource/api/mcp`. Root metadata still
 * exists; this is the URL a pathful resource MUST publish.
 */
export function protectedResourceMetadataUrl(origin: string) {
  return `${origin.replace(/\/$/, "")}/.well-known/oauth-protected-resource/api/mcp`;
}

export function authorizationServerMetadataUrl(origin: string) {
  return `${origin.replace(/\/$/, "")}/.well-known/oauth-authorization-server`;
}

/**
 * RFC 9728 challenge. `resource_metadata` is the PRM; `as_uri` is the
 * authorization-server metadata URL. Clients that only read one of the
 * two still find www discovery. `error` is set on 401/403 so a browser
 * does not treat a silent Bearer as a successful type match.
 */
export function oauthWwwAuthenticate(
  request?: Request,
  error?: string,
  description?: string,
) {
  const origin = oauthIssuer(request);
  const parts = [
    `resource_metadata="${protectedResourceMetadataUrl(origin)}"`,
    `as_uri="${authorizationServerMetadataUrl(origin)}"`,
    `scope="operate:read"`,
  ];
  if (error) parts.unshift(`error="${error}"`);
  if (description) {
    parts.push(
      `error_description="${description.replaceAll('"', "'")}"`,
    );
  }
  return `Bearer ${parts.join(", ")}`;
}

export function mcpWwwAuthenticate(request: Request) {
  return oauthWwwAuthenticate(request, "invalid_token");
}

export const OAUTH_SCOPES = [
  "openid",
  "email",
  "operate:read",
  "operate:write",
] as const;

export function oauthResource(request?: Request) {
  try {
    return validateMcpResource(undefined, oauthIssuer(request));
  } catch {
    return CANONICAL_PRODUCTION_MCP_RESOURCE;
  }
}

export function oauthDiscoveryMetadata(request?: Request) {
  const issuer = oauthIssuer(request);
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    userinfo_endpoint: `${issuer}/oauth/userinfo`,
    device_authorization_endpoint: `${issuer}/oauth/device`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: [
      "authorization_code",
      "refresh_token",
      DEVICE_GRANT,
      "device_code",
    ],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [...OAUTH_SCOPES],
    subject_types_supported: ["public"],
    claims_supported: ["sub", "email", "email_verified", "name"],
    resource_parameter_supported: true,
  };
}

/**
 * Token, device, and revoke all accept JSON or form bodies. An agent
 * hand-rolling curl reaches for JSON, often with no Content-Type, a
 * UTF-8 BOM, or `Content-Type: application/json` around a form body.
 * One text parse: strip a BOM, try JSON if labelled or the body starts
 * with `{`, otherwise application/x-www-form-urlencoded. A failed JSON
 * parse falls through to form — labelled-JSON + `token=…` used to
 * return empty and skip revoke.
 *
 * Body wins; the query string fills an empty field (some libraries POST
 * `?token=` / `?grant_type=` with no entity). Multipart is read before
 * text so a FormData client is not parsed as raw boundary noise.
 */
export async function oauthFields(
  request: Request,
): Promise<(name: string) => string> {
  const contentType = request.headers.get("content-type") ?? "";
  const query = new URL(request.url).searchParams;
  const withQuery = (fromBody: (name: string) => string) => {
    return (name: string) =>
      fromBody(name) || phpFieldString((key) => query.get(key) || "", name);
  };

  if (contentType.includes("multipart/form-data")) {
    try {
      const form = await request.formData();
      return withQuery((name) => phpFieldString((key) => {
        const value = form.get(key);
        return typeof value === "string" ? value : "";
      }, name));
    } catch {
      return withQuery(() => "");
    }
  }

  const text = (await request.text().catch(() => "")).replace(/^\uFEFF/, "");
  const trimmed = text.trim();
  const labelledJson =
    contentType.includes("application/json") ||
    contentType.includes("text/json") ||
    contentType.includes("+json");
  const looksJson = trimmed.startsWith("{") || trimmed.startsWith("[");
  if (labelledJson || looksJson) {
    try {
      const record = asJsonRecord(parseJsonBody(trimmed));
      if (record) {
        return withQuery((name) => phpRecordString(record, name));
      }
    } catch {
      // Fall through: a JSON Content-Type is sometimes wrapped around
      // an RFC form body.
    }
  }
  const params = new URLSearchParams(trimmed);
  return withQuery((name) => phpFieldString((key) => params.get(key) ?? "", name));
}

function phpFieldString(get: (name: string) => string, name: string) {
  for (const key of oauthFieldAliases(name)) {
    const value = get(key);
    if (value) return value;
  }
  return "";
}

function phpRecordString(record: Record<string, unknown>, name: string) {
  for (const key of oauthFieldAliases(name)) {
    const value = record[key];
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      const first = value.find((item) => item !== undefined && item !== null);
      if (first === undefined) continue;
      return typeof first === "string" ? first : String(first);
    }
    return typeof value === "string" ? value : String(value);
  }
  return "";
}

/** RFC 7009 puts `token` in the body; some logout clients send Bearer only. */
export function oauthBearer(request: Request) {
  return extractOperateCredential(
    request.headers.get("authorization"),
    new URL(request.url).searchParams,
    {
      apiKey:
        request.headers.get("x-api-key") || request.headers.get("api-key"),
      accessToken: request.headers.get("x-access-token"),
    },
  );
}

/** `device_code` is the short name clients send instead of the RFC 8628 URN. */
export function canonicalGrantType(value: string) {
  const grant = value.trim();
  const lower = grant.toLowerCase();
  if (
    lower === DEVICE_GRANT ||
    lower === "device_code" ||
    lower === "device-code" ||
    lower === "device"
  ) {
    return DEVICE_GRANT;
  }
  if (
    lower === "authorization_code" ||
    lower === "authorization-code" ||
    lower === "authorization" ||
    lower === "code"
  ) {
    return "authorization_code";
  }
  if (
    lower === "refresh_token" ||
    lower === "refresh-token" ||
    lower === "refresh"
  ) {
    return "refresh_token";
  }
  return grant;
}

/**
 * RFC 6749 §2.3.1. Public clients still send
 * `Authorization: Basic base64(client_id:)` with an empty secret, and no
 * `client_id` in the body. That used to 401 as "client_id is required".
 */
export function oauthBasicClientId(request: Request) {
  const authorization = request.headers.get("authorization") ?? "";
  const match = authorization.match(/^Basic\s+(\S+)/i);
  if (!match) return "";
  try {
    const decoded = Buffer.from(match[1], "base64").toString("utf8");
    const colon = decoded.indexOf(":");
    return (colon === -1 ? decoded : decoded.slice(0, colon)).trim();
  } catch {
    return "";
  }
}

/** Some clients wrap a single object in a JSON array. */
function asJsonRecord(body: unknown): Record<string, unknown> | null {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }
  if (
    Array.isArray(body) &&
    body.length === 1 &&
    body[0] &&
    typeof body[0] === "object" &&
    !Array.isArray(body[0])
  ) {
    return body[0] as Record<string, unknown>;
  }
  return null;
}

function coerceRedirectUris(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return value.filter(
      (item): item is string => typeof item === "string" && item.length > 0,
    );
  }
  if (typeof value !== "string" || !value.trim()) return undefined;
  const trimmed = value.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) return coerceRedirectUris(parsed);
    } catch {
      // A single URI, not a JSON array.
    }
  }
  return [trimmed];
}

function formRedirectKey(key: string) {
  const canonical = canonicalOAuthKey(key);
  if (canonical === "redirect_uri" || canonical === "redirect_uris") {
    return "redirect_uris";
  }
  return canonical;
}

function withRedirectUris(record: Record<string, unknown>) {
  if (!("redirect_uris" in record) && "redirect_uri" in record) {
    record.redirect_uris = record.redirect_uri;
  }
  const uris = coerceRedirectUris(record.redirect_uris);
  if (uris) record.redirect_uris = uris;
  return record;
}

function formClientMetadata(text: string): Record<string, unknown> | null {
  const params = new URLSearchParams(text);
  if (![...params.keys()].length) return null;
  const record: Record<string, unknown> = {};
  for (const rawKey of new Set(params.keys())) {
    const key = formRedirectKey(rawKey);
    const all = params.getAll(rawKey);
    if (key === "redirect_uris") {
      const uris: string[] = [];
      for (const raw of all) {
        const value = raw.trim();
        if (value.startsWith("[")) {
          try {
            const parsed = JSON.parse(value) as unknown;
            if (Array.isArray(parsed)) {
              for (const item of parsed) {
                if (typeof item === "string" && item) uris.push(item);
              }
              continue;
            }
          } catch {
            // A single URI that happens to start with `[`.
          }
        }
        if (value) uris.push(value);
      }
      record[key] = uris;
      continue;
    }
    record[key] = all.length > 1 ? all : (all[0] ?? "");
  }
  return withRedirectUris(record);
}

async function multipartClientMetadata(
  request: Request,
): Promise<Record<string, unknown> | null> {
  try {
    const form = await request.formData();
    const record: Record<string, unknown> = {};
    for (const [rawKey, value] of form.entries()) {
      if (typeof value !== "string") continue;
      const key = formRedirectKey(rawKey);
      if (key === "redirect_uris") {
        const next = coerceRedirectUris(value) ?? [];
        const existing = record[key];
        record[key] = Array.isArray(existing) ? [...existing, ...next] : next;
        continue;
      }
      record[key] = value;
    }
    return Object.keys(record).length ? withRedirectUris(record) : null;
  } catch {
    return null;
  }
}

/** DCR (RFC 7591) is JSON. Strip a BOM so request.json() is not the only path. */
export async function oauthJsonObject(
  request: Request,
): Promise<Record<string, unknown> | null> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    return multipartClientMetadata(request);
  }
  const text = (await request.text().catch(() => "")).replace(/^\uFEFF/, "").trim();
  try {
    const record = asJsonRecord(parseJsonBody(text));
    if (record) return withRedirectUris(canonicalizeOAuthRecord(record));
  } catch {
    // Fall through: some DCR clients POST form-urlencoded.
  }
  return formClientMetadata(text);
}

function canonicalizeOAuthRecord(record: Record<string, unknown>) {
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    next[canonicalOAuthKey(key)] = value;
  }
  return next;
}

export function oauthConvexClient() {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) throw new Error("NEXT_PUBLIC_CONVEX_URL is not configured");
  return new ConvexHttpClient(url);
}

export function randomCredential(prefix: string) {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

export function oauthJson(
  body: Record<string, unknown>,
  status = 200,
  extra?: Record<string, string>,
) {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      Pragma: "no-cache",
      ...oauthCorsHeaders(),
      ...extra,
    },
  });
}

export function oauthError(
  error: string,
  description: string,
  status = 400,
  request?: Request,
) {
  const challenge =
    status === 401 || status === 403
      ? {
          "WWW-Authenticate": oauthWwwAuthenticate(
            request,
            error,
            description,
          ),
        }
      : undefined;
  return oauthJson({ error, error_description: description }, status, challenge);
}

/** GET probes of token/revoke/register used to 404 from the catch-all. */
export function oauthPostOnly() {
  return oauthJson(
    { error: "invalid_request", error_description: "This endpoint accepts POST" },
    405,
    { Allow: "POST" },
  );
}
