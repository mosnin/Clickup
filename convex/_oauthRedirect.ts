/**
 * Redirect URIs a public OAuth client may register.
 *
 * DCR is anonymous and Convex mutations are publicly callable, so "any
 * HTTPS URL" is an open redirector: an attacker registers
 * `https://attacker.example/callback`, phishes a human through
 * `/oauth/authorize`, and the authorization code lands on their server.
 * PKCE does not help — the attacker started the flow and holds the
 * verifier.
 *
 * The launch clients are the public directories (ChatGPT, Claude) and
 * loopback runtimes (Claude Code, local MCP inspectors). Those hosts are
 * the allowlist. A new directory is one entry here, not a policy change.
 *
 * Checked on every use, not only at registration, so a client row written
 * before this rule (or inserted outside registerClient) cannot redeem a
 * code against an unofficial host.
 */

export const DIRECTORY_REDIRECT_HOSTS = [
  "chatgpt.com",
  "chat.openai.com",
  "platform.openai.com",
  "openai.com",
  "claude.ai",
  "claude.com",
  "anthropic.com",
] as const;

const DIRECTORY_HOSTS = new Set<string>(DIRECTORY_REDIRECT_HOSTS);

export const REDIRECT_URI_MAX_LENGTH = 2048;

export function isLoopbackRedirectHost(hostname: string) {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}

function isDirectoryRedirectHost(hostname: string) {
  const host = hostname.toLowerCase();
  if (DIRECTORY_HOSTS.has(host)) return true;
  for (const allowed of DIRECTORY_HOSTS) {
    if (host.endsWith(`.${allowed}`)) return true;
  }
  return false;
}

export function validRedirectUri(value: string) {
  if (!value || value.length > REDIRECT_URI_MAX_LENGTH) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username !== "" || url.password !== "") return false;
  if (url.hash !== "") return false;
  if (isLoopbackRedirectHost(url.hostname)) {
    return url.protocol === "http:" || url.protocol === "https:";
  }
  return (
    url.protocol === "https:" &&
    url.port === "" &&
    isDirectoryRedirectHost(url.hostname)
  );
}

export function redirectHost(value: string) {
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
}
