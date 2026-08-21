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
    pathname.startsWith("/oauth/.well-known") ||
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
  "Authorization, Content-Type, Accept, If-None-Match, MCP-Protocol-Version, Mcp-Protocol-Version, Mcp-Session-Id, Last-Event-ID, X-PAYMENT, X-Payment, X-Api-Key, X-API-Key, Api-Key, Token, X-Access-Token, Access-Token";

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
    if (!value) return;
    if (key === "scope") {
      const current = merged.get("scope");
      merged.set(
        "scope",
        normalizeOAuthScope(current ? `${current} ${value}` : value),
      );
      return;
    }
    if (!merged.get(key)) merged.set(key, value);
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
        for (const [rawKey, value] of Object.entries(record)) {
          if (value === undefined || value === null) continue;
          const key = canonicalOAuthKey(rawKey);
          if (Array.isArray(value) && key === "scope") {
            const scopes = value.filter(
              (item): item is string =>
                typeof item === "string" && item.length > 0,
            );
            if (scopes.length) setIfEmpty(key, scopes.join(" "));
            continue;
          }
          const first = Array.isArray(value) ? value[0] : value;
          if (first === undefined || first === null) continue;
          setIfEmpty(key, typeof first === "string" ? first : String(first));
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
  "client-id": "client_id",
  clientName: "client_name",
  redirectUri: "redirect_uri",
  "redirect-uri": "redirect_uri",
  redirectUris: "redirect_uris",
  "redirect-uris": "redirect_uris",
  redirect_url: "redirect_uri",
  redirectUrl: "redirect_uri",
  callback_uri: "redirect_uri",
  callback_url: "redirect_uri",
  callbackUri: "redirect_uri",
  callbackUrl: "redirect_uri",
  grantType: "grant_type",
  "grant-type": "grant_type",
  deviceCode: "device_code",
  userCode: "user_code",
  refreshToken: "refresh_token",
  accessToken: "access_token",
  apiKey: "api_key",
  codeVerifier: "code_verifier",
  verifier: "code_verifier",
  codeChallenge: "code_challenge",
  "code-challenge": "code_challenge",
  codeChallengeMethod: "code_challenge_method",
  "code-challenge-method": "code_challenge_method",
  tokenTypeHint: "token_type_hint",
  scopes: "scope",
  responseType: "response_type",
  /** Some clients POST `grant=code` instead of `grant_type`. */
  grant: "grant_type",
};

/** PKCE S256, including `s256`, `sha256`, and hyphenated forms. */
export function canonicalCodeChallengeMethod(value: string) {
  const compact = value.trim().toLowerCase().replace(/[-_]/g, "");
  if (!compact || compact === "s256" || compact === "sha256") return "S256";
  return value.trim();
}

const CANONICAL_OAUTH_KEYS = new Set<string>([
  ...Object.values(OAUTH_KEY_ALIASES),
  "client_id",
  "client_name",
  "redirect_uri",
  "redirect_uris",
  "grant_type",
  "device_code",
  "user_code",
  "refresh_token",
  "access_token",
  "api_key",
  "code_verifier",
  "code_challenge",
  "code_challenge_method",
  "token_type_hint",
  "scope",
  "response_type",
  "resource",
  "token",
  "code",
  "state",
]);

export function canonicalOAuthKey(key: string) {
  const stripped = key.replace(/\[\d*\]$/, "");
  if (OAUTH_KEY_ALIASES[stripped]) return OAUTH_KEY_ALIASES[stripped];
  const lower = stripped.toLowerCase();
  if (OAUTH_KEY_ALIASES[lower]) return OAUTH_KEY_ALIASES[lower];
  const snake = lower.replace(/-/g, "_");
  if (OAUTH_KEY_ALIASES[snake]) return OAUTH_KEY_ALIASES[snake];
  if (CANONICAL_OAUTH_KEYS.has(snake)) return snake;
  if (stripped.includes("-")) return snake;
  return stripped;
}

/** snake_case plus the camelCase / PHP `[]` names JS and PHP clients send. */
export function oauthFieldAliases(name: string) {
  const hyphen = name.replace(/_/g, "-");
  const aliases = [name, `${name}[]`, `${name}[0]`];
  if (hyphen !== name) aliases.push(hyphen, `${hyphen}[]`, `${hyphen}[0]`);
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
  if (name === "resource") aliases.push("audience", "aud");
  if (name === "scope") aliases.push("scopes");
  if (name === "response_type") aliases.push("responseType");
  if (name === "grant_type") aliases.push("grant", "grant-type");
  if (name === "redirect_uri") {
    aliases.push(
      "redirect_url",
      "redirectUrl",
      "callback_uri",
      "callback_url",
      "callbackUri",
      "callbackUrl",
      "redirect-uri",
      "redirect-uris",
    );
  }
  if (name === "client_id") aliases.push("client-id");
  return aliases;
}

/** Comma-separated scopes become the space-delimited RFC 6749 form. */
export function normalizeOAuthScope(value: string) {
  if (!value.includes(",")) return value;
  return value.replace(/,/g, " ").replace(/\s+/g, " ").trim();
}

function oauthFieldStrings(
  raw: string | string[] | null | undefined,
): string[] {
  if (raw == null) return [];
  const items = Array.isArray(raw) ? raw : [raw];
  return items.filter((item) => item.length > 0);
}

/** Query/form keys are case-sensitive; Token / Api-Key headers are not. */
export function foldSearchAll(
  params: { forEach: (cb: (value: string, key: string) => void) => void },
  key: string,
): string | string[] {
  const wanted = key.toLowerCase();
  const all: string[] = [];
  params.forEach((value, name) => {
    if (name.toLowerCase() === wanted) all.push(value);
  });
  return all.length <= 1 ? (all[0] ?? "") : all;
}

/** Credentials and scalar query fields are one value, never an array. */
export function firstFolded(
  params: { forEach: (cb: (value: string, key: string) => void) => void },
  key: string,
): string {
  const raw = foldSearchAll(params, key);
  return Array.isArray(raw) ? (raw[0] ?? "") : raw;
}

export function oauthParamGet(
  params: Record<string, string | string[] | undefined>,
): (name: string) => string | string[] | undefined {
  return (name) => {
    if (params[name] !== undefined) return params[name];
    const wanted = name.toLowerCase();
    const collected: string[] = [];
    for (const [key, value] of Object.entries(params)) {
      if (key.toLowerCase() !== wanted) continue;
      if (typeof value === "string" && value) collected.push(value);
      else if (Array.isArray(value)) {
        for (const item of value) if (item) collected.push(item);
      }
    }
    if (!collected.length) return undefined;
    return collected.length === 1 ? collected[0] : collected;
  };
}

/**
 * Same aliases as `oauthFields`, for authorize GET / `/link` query
 * strings. Next.js `searchParams` is `string | string[]`; token JSON
 * already joins scope arrays — GET must too.
 */
export function oauthQueryValue(
  get: (name: string) => string | string[] | null | undefined,
  name: string,
) {
  for (const key of oauthFieldAliases(name)) {
    const values = oauthFieldStrings(get(key));
    if (!values.length) continue;
    if (name === "scope") return normalizeOAuthScope(values.join(" "));
    return values[0];
  }
  return "";
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
  // Clients that treat `/oauth` as the issuer construct
  // `/oauth/.well-known/oauth-authorization-server` and 404'd.
  if (next === "/oauth/.well-known") {
    next = "/.well-known/oauth-authorization-server";
  } else if (next.startsWith("/oauth/.well-known/")) {
    next = next.slice("/oauth".length);
  }
  if (next === "/mcp.json" || next === "/api/mcp.json") next = "/api/mcp";
  if (next.endsWith(".json")) {
    const withoutJson = next.slice(0, -".json".length);
    if (withoutJson === "/mcp") next = "/api/mcp";
    else if (
      withoutJson.includes("/.well-known/") &&
      (withoutJson.includes("oauth-protected-resource") ||
        withoutJson.includes("oauth-authorization-server") ||
        withoutJson.includes("openid-configuration") ||
        withoutJson.includes("webfinger") ||
        withoutJson.includes("host-meta") ||
        withoutJson.endsWith("/.well-known/mcp"))
    ) {
      next = withoutJson;
    } else if (isOAuthSlashRewritePath(withoutJson)) {
      next = withoutJson;
    }
  }
  // Root-only cards. After /mcp → /api/mcp (and .json strip) these
  // would 404 under /api/mcp/.well-known/.
  if (
    next === "/api/mcp/.well-known/mcp" ||
    next === "/api/mcp/.well-known/webfinger" ||
    next === "/api/mcp/.well-known/host-meta"
  ) {
    next = next.slice("/api/mcp".length);
  }
  if (next !== pathname && isOAuthSlashRewritePath(next)) return next;
  if (stripped === pathname) return null;
  if (isOAuthSlashRewritePath(stripped)) return stripped;
  return null;
}

const OPERATE_CREDENTIAL = /^(cua_|opa_|opr_|opc_|opd_)/i;
/** `Token cua_`, `Token: cua_`, `Token:cua_`. Not `Tokencua_`. */
const AUTH_SCHEME_PREFIX = /^(Bearer|Token|Api-?Key|ApiKey)(?::\s*|\s+)/i;
const AUTH_PART =
  /,(?=\s*(?:Bearer|Token|Api-?Key|ApiKey|Basic)(?::\s*|\s+))/i;
const BASIC_PREFIX = /^Basic(?::\s*|\s+)/i;

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

/** Peel repeated `Bearer Bearer cua_…` / `Token Token …` prefixes. */
function peelAuthorization(header: string) {
  let rest = header.trim();
  while (AUTH_SCHEME_PREFIX.test(rest)) {
    rest = rest.replace(AUTH_SCHEME_PREFIX, "").trim();
  }
  return unwrapCredential(rest);
}

/**
 * Fetch concatenates duplicate Authorization headers with `, `.
 * Basic in a part is never a bearer; a later Bearer/Token still is.
 */
function credentialFromAuthorization(header: string) {
  const parts = header.split(AUTH_PART);
  for (const part of parts) {
    const piece = part.trim();
    if (!piece || BASIC_PREFIX.test(piece)) continue;
    if (AUTH_SCHEME_PREFIX.test(piece)) return peelAuthorization(piece);
    const raw = unwrapCredential(piece);
    if (OPERATE_CREDENTIAL.test(raw) && !raw.includes(" ")) return raw;
  }
  return "";
}

function dedicatedHeaderToken(value: string | null | undefined) {
  const token = value?.trim() ?? "";
  if (!token || BASIC_PREFIX.test(token)) return "";
  return peelAuthorization(token);
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
): string {
  const header = authorization?.trim() ?? "";
  if (header) {
    const fromHeader = credentialFromAuthorization(header);
    if (fromHeader) return fromHeader;
  }
  const dedicated =
    dedicatedHeaderToken(extra?.apiKey) ||
    dedicatedHeaderToken(extra?.accessToken);
  if (dedicated) return dedicated;
  if (query) {
    const get = (key: string) => foldSearchAll(query, key);
    return (
      oauthQueryValue(get, "access_token") ||
      oauthQueryValue(get, "api_key") ||
      firstFolded(query, "token") ||
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
        headers.get("x-access-token") ||
        headers.get("access-token") ||
        headers.get("token"),
    },
  );
  if (!token) return headers;
  const current = (headers.get("authorization") ?? "").trim();
  if (current.toLowerCase() === `bearer ${token}`.toLowerCase()) return headers;
  headers.set("Authorization", `Bearer ${token}`);
  return headers;
}
