# Native Codex connection

The plugin uses the product HTTP MCP endpoint and browser OAuth consent. External users must not run a terminal login command or provision personal client secrets. Codex owns its temporary callback listener; every new sign-in must use the callback from that active attempt.

Registration identifies the application, not a user or organization. The authenticated account supplies authority after consent. Token validation and membership checks remain on the product server.

Source regression tests cover native connection behavior. Hosted deployment, real external-user consent, authenticated reads, and revocation must be accepted separately. A successful build does not prove account access.
