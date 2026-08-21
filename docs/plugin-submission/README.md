# Operate public plugin submission

This folder is the reviewer-ready dossier for the same production integration on both supported public surfaces:

- OpenAI universal Plugins Directory (ChatGPT and Codex): combined MCP + skills plugin.
- Anthropic Connectors Directory (Claude web, Desktop, mobile, Code, and API): remote MCP connector.

Production endpoints:

- ChatGPT MCP: `https://www.operate.to/api/mcp?profile=chatgpt`
- Claude MCP: `https://www.operate.to/api/mcp?profile=claude`
- OAuth protected-resource metadata: `https://www.operate.to/.well-known/oauth-protected-resource` (RFC 9728 path form: `https://www.operate.to/.well-known/oauth-protected-resource/api/mcp`)
- OAuth authorization-server metadata: `https://www.operate.to/.well-known/oauth-authorization-server`
- OpenID discovery: `https://www.operate.to/.well-known/openid-configuration`
- Verified-email UserInfo: `https://www.operate.to/oauth/userinfo`
- Documentation and support: `https://operate.to/plugins`
- Privacy: `https://operate.to/legal/privacy`
- Terms: `https://operate.to/legal/terms`

The server supports Streamable HTTP, OAuth 2.1 authorization code + PKCE, dynamic client registration with bounded anonymous writes, a directory-host redirect allowlist (ChatGPT / Claude / loopback; checked on every use), exact protected-resource binding, rotating refresh tokens, revocation, OpenID discovery, verified-email UserInfo, 90-day device-grant API keys (capped at five live keys per agent), and legacy human-minted agent API-key authentication for custom runtimes. OAuth access is bound to a user-selected Operate agent. Personal agents are selectable only by their owner; workspace-wide agents are selectable only by the workspace owner because their server-side boundary includes private Spaces. Existing list restrictions, read-only roles, budgets, approvals, and agent pause controls continue to apply.

Both profiles advertise explicit safety annotations, OAuth requirements, and a stable structured-output envelope for every tool. The ChatGPT endpoint currently exposes 184 production-backed tools and uses OpenAI’s narrower destructive-action definition. Both public directory profiles omit `buy_credits`, `settle_payment`, and deprecated Folder aliases. Both retain read-only wallet visibility through `get_wallet`; custom MCP clients using the base endpoint retain the complete payment lifecycle.

The uploadable OpenAI bundle is generated from `plugins/operate`; `chatgpt-app-submission.json` is generated from the live MCP registry and imported separately in OpenAI’s review form. Anthropic reviews the production remote MCP endpoint and the information in `claude.md`; it does not use a local demo bundle. Do not put reviewer credentials in the repository or ZIP. Enter them only in each platform’s secure submission form.

Human-only portal prerequisites:

1. Verify the Operate publisher identity in the OpenAI organization.
2. Give the submitter Apps Management write access.
3. Create a stable reviewer account with representative sample data, no MFA, and the minimum workspace role needed to exercise submitted tools.
4. Enter credentials only in the secure reviewer-credentials field.
5. When OpenAI produces its domain token, set `OPENAI_APPS_CHALLENGE` in production and verify the exact plaintext response at `/.well-known/openai-apps-challenge`.
