import { ConvexError } from "convex/values";

export type OAuthResourceKind = "mcp" | "companyos";

const RESOURCE_PATHS: Record<OAuthResourceKind, string> = {
  mcp: "/api/mcp",
  companyos: "/api/companyos",
};

function normalizeOrigin(raw?: string) {
  const value = raw?.trim() || "https://www.operate.to";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConvexError("NEXT_PUBLIC_APP_URL must be an absolute origin");
  }
  const isLocal =
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if (
    (url.protocol !== "https:" && !isLocal) ||
    url.username !== "" ||
    url.password !== "" ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new ConvexError("NEXT_PUBLIC_APP_URL must be an HTTPS origin");
  }
  if (url.hostname === "operate.to" || url.hostname === "www.operate.to") {
    return "https://www.operate.to";
  }
  return url.origin;
}

function normalizedResourceUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConvexError("resource must be a canonical Operate URL");
  }
  if (url.hostname === "operate.to" || url.hostname === "www.operate.to") {
    if (url.protocol !== "https:" || url.port !== "") {
      throw new ConvexError("resource must be a canonical Operate URL");
    }
    url.hostname = "www.operate.to";
  }
  return url;
}

export function requireOAuthResource(
  value: string,
  requiredKind?: OAuthResourceKind,
): { resource: string; kind: OAuthResourceKind } {
  const clean = value.trim();
  if (!clean || clean.length > 2_048) {
    throw new ConvexError("resource must be 1-2048 characters");
  }
  const url = normalizedResourceUrl(clean);
  const allowedOrigin = normalizeOrigin(process.env.NEXT_PUBLIC_APP_URL);
  const isAllowedLocal =
    allowedOrigin.startsWith("http://") && url.origin === allowedOrigin;
  const kind = (Object.entries(RESOURCE_PATHS).find(
    ([, path]) => path === url.pathname,
  )?.[0] ?? null) as OAuthResourceKind | null;
  if (
    (!isAllowedLocal && url.protocol !== "https:") ||
    url.origin !== allowedOrigin ||
    !kind ||
    (requiredKind !== undefined && kind !== requiredKind) ||
    url.search !== "" ||
    url.hash !== "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new ConvexError("resource must be a canonical Operate URL");
  }
  return { resource: url.toString(), kind };
}

export function oauthResourcesMatch(
  stored: string | undefined,
  expected: string,
) {
  if (!stored) return false;
  try {
    return (
      normalizedResourceUrl(stored).toString() ===
      normalizedResourceUrl(expected).toString()
    );
  } catch {
    return false;
  }
}

/**
 * A non-secret, deterministic identity for one pre-grant-family OAuth
 * authority envelope. Historical refresh rotations did not retain ancestry,
 * so a replay must fail closed across this exact subject/client/audience and
 * principal rather than guessing which one of its successors is related.
 */
export function oauthLegacyAuthorityKey(input: {
  clientId: string;
  resource: string;
  userClerkId: string;
  agentId?: string;
  workspaceId?: string;
}) {
  return JSON.stringify([
    input.clientId,
    normalizedResourceUrl(input.resource).toString(),
    input.userClerkId,
    input.agentId ?? null,
    input.workspaceId ?? null,
  ]);
}
