# Operate public plugin submission

This folder is the reviewer-ready dossier for the same production integration on both supported public surfaces:

- OpenAI universal Plugins Directory (ChatGPT and Codex): combined MCP + skills plugin.
- Anthropic Connectors Directory (Claude web, Desktop, mobile, Code, and API): remote MCP connector.

Production endpoints:

- MCP: `https://operate.to/api/mcp`
- OAuth protected-resource metadata: `https://operate.to/.well-known/oauth-protected-resource`
- OAuth authorization-server metadata: `https://operate.to/.well-known/oauth-authorization-server`
- Documentation and support: `https://operate.to/plugins`
- Privacy: `https://operate.to/legal/privacy`
- Terms: `https://operate.to/legal/terms`

The server supports Streamable HTTP, OAuth 2.1 authorization code + PKCE, dynamic client registration, rotating refresh tokens, revocation, and legacy agent API-key authentication for custom runtimes. OAuth access is bound to a user-selected Operate agent, so existing workspace boundaries, list restrictions, read-only roles, budgets, approvals, and agent pause controls continue to apply.

The uploadable OpenAI bundle is generated from `plugins/operate`. Do not put reviewer credentials in the repository or ZIP. Enter them only in each platform’s secure submission form.

Human-only portal prerequisites:

1. Verify the Operate publisher identity in the OpenAI organization.
2. Give the submitter Apps Management write access.
3. Create a stable reviewer account with representative sample data, no MFA, and the minimum workspace role needed to exercise submitted tools.
4. Enter credentials only in the secure reviewer-credentials field.
5. When OpenAI produces its domain token, set `OPENAI_APPS_CHALLENGE` in production and verify the exact plaintext response at `/.well-known/openai-apps-challenge`.
