import { describe, expect, it } from "vitest";
import {
  DIRECTORY_REDIRECT_HOSTS,
  redirectHost,
  validRedirectUri,
} from "../convex/_oauthRedirect";

describe("OAuth redirect allowlist", () => {
  it("accepts directory hosts and loopback, and nothing else", () => {
    const accepted = [
      "https://claude.ai/api/mcp/auth_callback",
      "https://chatgpt.com/connector_platform_oauth_redirect",
      "https://www.chatgpt.com/connector_platform_oauth_redirect",
      "https://platform.openai.com/apps/callback",
      "http://localhost:8787/callback",
      "http://127.0.0.1:54321/callback",
      "http://[::1]:3000/callback",
    ];
    for (const uri of accepted) expect(validRedirectUri(uri)).toBe(true);

    const refused = [
      "https://attacker.example/callback",
      "http://attacker.example/callback",
      "https://chatgpt.com.evil.example/callback",
      "https://notclaude.ai/callback",
      "https://user:pass@claude.ai/callback",
      "https://claude.ai/callback#frag",
      "https://claude.ai:8443/callback",
      "https://192.168.1.10/callback",
      "javascript:alert(1)",
      "https://clickup-phi.vercel.app/callback",
    ];
    for (const uri of refused) expect(validRedirectUri(uri)).toBe(false);
  });

  it("names the directory hosts the launch clients actually use", () => {
    expect(DIRECTORY_REDIRECT_HOSTS).toEqual(
      expect.arrayContaining([
        "chatgpt.com",
        "claude.ai",
        "claude.com",
        "openai.com",
        "anthropic.com",
      ]),
    );
  });

  it("exposes the hostname the consent screen shows", () => {
    expect(redirectHost("https://claude.ai/api/mcp/auth_callback")).toBe(
      "claude.ai",
    );
    expect(redirectHost("not a url")).toBeNull();
  });
});
