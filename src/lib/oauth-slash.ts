/**
 * Next/Vercel 308s `/oauth/token/` → `/oauth/token`. Many OAuth clients
 * drop the POST body on 308 (same class as the apex host redirect).
 * `skipTrailingSlashRedirect` stops that 308; without a rewrite the
 * slashed URL 404s (`/link/`, `/api/x402/`, doubled slashes).
 *
 * Machine paths rewrite without Clerk (token/MCP must not go through
 * JWT middleware). Human paths (`/oauth/authorize`, `/link`) rewrite
 * *after* Clerk so `auth()` still sees the session.
 *
 * Never `/dashboard/` — a rewrite that skipped Clerk would skip
 * `auth.protect()`.
 *
 * Lives in its own module so Edge middleware does not import
 * `oauth-server.ts` (`node:crypto` / Convex).
 */
export function isMachineOAuthPath(pathname: string) {
  return (
    pathname === "/oauth" ||
    pathname === "/oauth/token" ||
    pathname === "/oauth/device" ||
    pathname === "/oauth/revoke" ||
    pathname === "/oauth/register" ||
    pathname === "/oauth/userinfo" ||
    pathname === "/api/mcp" ||
    pathname.startsWith("/api/mcp/") ||
    pathname === "/mcp" ||
    pathname.startsWith("/mcp/") ||
    pathname === "/api/x402" ||
    pathname.startsWith("/api/x402/") ||
    pathname === "/api/agent" ||
    pathname.startsWith("/api/agent/") ||
    pathname.startsWith("/.well-known/") ||
    pathname === "/start" ||
    pathname === "/connect" ||
    pathname === "/install" ||
    pathname.startsWith("/install/") ||
    pathname === "/skills" ||
    pathname.startsWith("/skills/")
  );
}

export function isHumanOAuthPath(pathname: string) {
  return (
    pathname === "/oauth/authorize" ||
    pathname.startsWith("/oauth/authorize/") ||
    pathname === "/link" ||
    pathname.startsWith("/link/")
  );
}

export function isAuthorizePath(pathname: string) {
  return (
    pathname === "/oauth/authorize" || pathname.startsWith("/oauth/authorize/")
  );
}

/** OPTIONS must be answered before Clerk on authorize/link. */
export function isOAuthOptionsPath(pathname: string) {
  return isMachineOAuthPath(pathname) || isHumanOAuthPath(pathname);
}

export const OAUTH_CORS_ALLOW_HEADERS =
  "Authorization, Content-Type, Accept, If-None-Match, MCP-Protocol-Version, Mcp-Protocol-Version, Mcp-Session-Id, Last-Event-ID, X-PAYMENT, X-Payment, X-Api-Key, X-API-Key, Api-Key, X-Access-Token, Access-Token";

export const OAUTH_CORS_EXPOSE_HEADERS =
  "WWW-Authenticate, ETag, Mcp-Session-Id, X-PAYMENT-RESPONSE";

/**
 * Public OAuth/MCP discovery is readable cross-origin. Lives here so
 * Edge middleware can answer OPTIONS without importing `oauth-server`
 * (`node:crypto` / Convex).
 */
export function mergeAllowHeaders(requested: string | null | undefined) {
  if (!requested?.trim()) return OAUTH_CORS_ALLOW_HEADERS;
  return `${OAUTH_CORS_ALLOW_HEADERS}, ${requested}`;
}

export function oauthCorsHeaders(request?: Request) {
  const origin = request?.headers.get("origin")?.trim();
  const allowOrigin =
    origin && origin !== "null" && origin !== "*" ? origin : "*";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    ...(allowOrigin !== "*"
      ? { "Access-Control-Allow-Credentials": "true" }
      : {}),
    "Access-Control-Allow-Methods": "GET, HEAD, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": mergeAllowHeaders(
      request?.headers.get("access-control-request-headers"),
    ),
    "Access-Control-Expose-Headers": OAUTH_CORS_EXPOSE_HEADERS,
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

export function oauthOptions(request?: Request) {
  return new Response(null, {
    status: 204,
    headers: oauthCorsHeaders(request),
  });
}

export function isMcpBrowserOrigin(origin: string | null) {
  if (!origin) return false;
  let host: string;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === "localhost" || host === "127.0.0.1" || host === "[::1]") {
    return true;
  }
  if (
    host === "chatgpt.com" ||
    host === "www.chatgpt.com" ||
    host === "chat.openai.com" ||
    host === "platform.openai.com" ||
    host === "claude.ai" ||
    host === "www.claude.ai" ||
    host === "claude.com" ||
    host === "www.claude.com" ||
    host === "cursor.com" ||
    host === "www.cursor.com" ||
    host === "cursor.sh" ||
    host === "www.cursor.sh"
  ) {
    return true;
  }
  return (
    host.endsWith(".chatgpt.com") ||
    host.endsWith(".claude.ai") ||
    host.endsWith(".claude.com") ||
    host.endsWith(".cursor.com") ||
    host.endsWith(".cursor.sh")
  );
}

/**
 * 200 MCP responses stay origin-allowlisted (Bearer is not a cookie, but
 * a stolen key in page JS should not become readable). 401 and OPTIONS
 * are public: a browser must read `WWW-Authenticate` / pass preflight
 * even from `www.chatgpt.com`, localhost inspector, or a new subdomain
 * we have not listed yet.
 */
export function isMcpAuthChallenge(response: Response) {
  return (
    response.status === 401 ||
    response.status === 403 ||
    response.headers.has("WWW-Authenticate")
  );
}

export function applyMcpCors(req: Request, response: Response) {
  const origin = req.headers.get("origin");
  const known = isMcpBrowserOrigin(origin);
  const open = req.method === "OPTIONS" || isMcpAuthChallenge(response);
  if (!open && !known) return response;

  const headers = new Headers(response.headers);
  const allowOrigin = origin && (known || open) ? origin : "*";
  headers.set("Access-Control-Allow-Origin", allowOrigin);
  if (allowOrigin !== "*") {
    // credentials:include is how some browser MCP clients send the
    // preflight; * + Allow-Credentials is illegal and hides 401.
    headers.set("Access-Control-Allow-Credentials", "true");
  }
  headers.set("Access-Control-Allow-Methods", "GET, HEAD, POST, DELETE, OPTIONS");
  headers.set(
    "Access-Control-Allow-Headers",
    mergeAllowHeaders(req.headers.get("access-control-request-headers")),
  );
  headers.set("Access-Control-Expose-Headers", OAUTH_CORS_EXPOSE_HEADERS);
  headers.set("Access-Control-Max-Age", "86400");
  headers.append("Vary", "Origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

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

/**
 * RFC 6749 allows POST to authorize. We only have a GET page, so
 * middleware 303s here (not 308 — that would drop the body) onto
 * `/oauth/authorize?...`.
 */
export async function readAuthorizeParams(request: Request) {
  const merged = new URLSearchParams(new URL(request.url).searchParams);
  const setIfEmpty = (key: string, value: string) => {
    if (value && !merged.get(key)) merged.set(key, value);
  };
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    try {
      const form = await request.formData();
      for (const [key, value] of form.entries()) {
        if (typeof value === "string") setIfEmpty(canonicalOAuthKey(key), value);
      }
    } catch {
      // Fall through with query only.
    }
    return merged;
  }
  const text = (await request.text().catch(() => "")).replace(/^\uFEFF/, "").trim();
  if (
    contentType.includes("application/json") ||
    contentType.includes("text/json") ||
    contentType.includes("+json") ||
    text.startsWith("{") ||
    text.startsWith("[")
  ) {
    try {
      const record = asJsonRecord(parseJsonBody(text));
      if (record) {
        for (const [key, value] of Object.entries(record)) {
          if (value === undefined || value === null) continue;
          const first = Array.isArray(value) ? value[0] : value;
          if (first === undefined || first === null) continue;
          setIfEmpty(
            canonicalOAuthKey(key),
            typeof first === "string" ? first : String(first),
          );
        }
        return merged;
      }
    } catch {
      // Fall through to form.
    }
  }
  const params = new URLSearchParams(text);
  for (const [key, value] of params.entries()) {
    setIfEmpty(canonicalOAuthKey(key), value);
  }
  return merged;
}

const OAUTH_KEY_ALIASES: Record<string, string> = {
  clientId: "client_id",
  clientName: "client_name",
  redirectUri: "redirect_uri",
  redirectUris: "redirect_uris",
  redirect_url: "redirect_uri",
  redirectUrl: "redirect_uri",
  callback_uri: "redirect_uri",
  callback_url: "redirect_uri",
  callbackUri: "redirect_uri",
  callbackUrl: "redirect_uri",
  grantType: "grant_type",
  deviceCode: "device_code",
  userCode: "user_code",
  refreshToken: "refresh_token",
  accessToken: "access_token",
  codeVerifier: "code_verifier",
  verifier: "code_verifier",
  codeChallenge: "code_challenge",
  codeChallengeMethod: "code_challenge_method",
  tokenTypeHint: "token_type_hint",
  scopes: "scope",
  responseType: "response_type",
  /** Some clients POST `grant=code` instead of `grant_type`. */
  grant: "grant_type",
};

export function canonicalOAuthKey(key: string) {
  const stripped = key.replace(/\[\d*\]$/, "");
  return OAUTH_KEY_ALIASES[stripped] ?? stripped;
}

/** snake_case plus the camelCase / PHP `[]` names JS and PHP clients send. */
export function oauthFieldAliases(name: string) {
  const aliases = [name, `${name}[]`, `${name}[0]`];
  for (const [camel, snake] of Object.entries(OAUTH_KEY_ALIASES)) {
    if (snake === name) aliases.push(camel, `${camel}[]`, `${camel}[0]`);
  }
  if (name === "token") {
    aliases.push(
      "access_token",
      "refresh_token",
      "accessToken",
      "refreshToken",
    );
  }
  if (name === "resource") aliases.push("audience");
  if (name === "scope") aliases.push("scopes");
  if (name === "response_type") aliases.push("responseType");
  if (name === "grant_type") aliases.push("grant");
  if (name === "redirect_uri") {
    aliases.push(
      "redirect_url",
      "redirectUrl",
      "callback_uri",
      "callback_url",
      "callbackUri",
      "callbackUrl",
    );
  }
  return aliases;
}

/** A proxy sometimes JSON.stringifies an already-encoded object. */
export function parseJsonBody(text: string): unknown {
  let value: unknown = JSON.parse(text);
  if (typeof value === "string") {
    const inner = value.trim();
    if (inner.startsWith("{") || inner.startsWith("[")) {
      try {
        value = JSON.parse(inner);
      } catch {
        // Keep the string.
      }
    }
  }
  return value;
}

export function isOAuthSlashRewritePath(pathname: string) {
  return (
    isMachineOAuthPath(pathname) ||
    isHumanOAuthPath(pathname) ||
    pathname === "/oauth" ||
    pathname.startsWith("/oauth/")
  );
}

export function stripOAuthTrailingSlash(pathname: string) {
  if (pathname.length < 2) return null;
  const collapsed = pathname.replace(/\/{2,}/g, "/");
  const stripped =
    collapsed.length > 1 && collapsed.endsWith("/")
      ? collapsed.slice(0, -1)
      : collapsed;
  let next = stripped;
  // Clients that guess the MCP default path (`/mcp`) used to 404.
  if (next === "/mcp") next = "/api/mcp";
  else if (next.startsWith("/mcp/")) next = `/api/mcp/${next.slice("/mcp/".length)}`;
  if (next === "/mcp.json" || next === "/api/mcp.json") next = "/api/mcp";
  if (next.endsWith(".json")) {
    const withoutJson = next.slice(0, -".json".length);
    if (withoutJson === "/mcp") next = "/api/mcp";
    else if (
      withoutJson.includes("/.well-known/") &&
      (withoutJson.includes("oauth-protected-resource") ||
        withoutJson.includes("oauth-authorization-server") ||
        withoutJson.includes("openid-configuration") ||
        withoutJson.endsWith("/.well-known/mcp"))
    ) {
      next = withoutJson;
    } else if (isOAuthSlashRewritePath(withoutJson)) {
      next = withoutJson;
    }
  }
  if (next !== pathname && isOAuthSlashRewritePath(next)) return next;
  if (stripped === pathname) return null;
  if (isOAuthSlashRewritePath(stripped)) return stripped;
  return null;
}

const OPERATE_CREDENTIAL = /^(cua_|opa_|opr_|opc_|opd_)/i;
const AUTH_SCHEME =
  /^(Bearer|Token|Api-?Key|ApiKey)\s+(\S+)/i;

/** `Bearer "cua_…"`, `Token token=cua_…`. Never applied to Basic. */
function unwrapCredential(raw: string) {
  let token = raw.trim().replace(/,+$/, "");
  const named =
    token.match(/^token\s*=\s*"([^"]+)"$/i) ||
    token.match(/^token\s*=\s*'([^']+)'$/i) ||
    token.match(/^token\s*=\s*(\S+)$/i);
  if (named) token = named[1];
  if (
    token.length >= 2 &&
    ((token.startsWith('"') && token.endsWith('"')) ||
      (token.startsWith("'") && token.endsWith("'")))
  ) {
    token = token.slice(1, -1);
  }
  return token;
}

function dedicatedHeaderToken(value: string | null | undefined) {
  const token = value?.trim() ?? "";
  if (!token || /^Basic\s+/i.test(token)) return "";
  const scheme = token.match(AUTH_SCHEME);
  if (scheme) return unwrapCredential(scheme[2]);
  return unwrapCredential(token);
}

/**
 * MCP and OAuth clients send `Authorization: cua_…` (no scheme),
 * `Token`, or `Api-Key`. `withMcpAuth` only reads `Bearer`. Query
 * `apiKey` / `access_token` and `X-Api-Key` / `X-Access-Token` are
 * the same hole x402 already closed.
 * Never treats `Basic` as a bearer token.
 */
export function extractOperateCredential(
  authorization: string | null | undefined,
  query?: URLSearchParams,
  extra?: { apiKey?: string | null; accessToken?: string | null },
) {
  const header = authorization?.trim() ?? "";
  if (header) {
    const scheme = header.match(AUTH_SCHEME);
    if (scheme) return unwrapCredential(scheme[2]);
    if (!/^Basic\s+/i.test(header)) {
      const raw = unwrapCredential(header);
      if (OPERATE_CREDENTIAL.test(raw) && !raw.includes(" ")) {
        return raw;
      }
    }
  }
  const dedicated =
    dedicatedHeaderToken(extra?.apiKey) ||
    dedicatedHeaderToken(extra?.accessToken);
  if (dedicated) return dedicated;
  if (query) {
    return (
      query.get("access_token") ||
      query.get("access-token") ||
      query.get("apiKey") ||
      query.get("api_key") ||
      ""
    );
  }
  return "";
}

export function applyOperateAuthorization(headers: Headers, url: string) {
  const token = extractOperateCredential(
    headers.get("authorization"),
    new URL(url).searchParams,
    {
      apiKey: headers.get("x-api-key") || headers.get("api-key"),
      accessToken:
        headers.get("x-access-token") || headers.get("access-token"),
    },
  );
  if (!token) return headers;
  if (/^Bearer\s+\S+/i.test(headers.get("authorization") ?? "")) return headers;
  headers.set("Authorization", `Bearer ${token}`);
  return headers;
}
