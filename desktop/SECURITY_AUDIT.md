# Application Security Launch Audit

## Scope

- Repository or app: Operate web application, macOS Tauri client, and native CLI
- Environment reviewed: Local checkout plus safe unauthenticated production HTTP checks
- Audit mode: Static review, local build/test, dependency scan, and non-destructive endpoint verification
- Live external testing approved: No intrusive production testing; only public GET/HEAD and an unauthenticated MCP request
- Date: 2026-09-07
- Auditor: Codex using the app-security-launch-auditor procedure

## App Profile

- Product type: Multi-tenant work management and agent orchestration SaaS
- Stack: Next.js, React, Convex, Clerk, MCP, Tauri 2, Rust
- Auth provider: Clerk for people; OAuth authorization code with PKCE and device authorization for agents
- Database and storage: Convex; macOS Keychain for CLI credentials
- Deployment host: Vercel and Convex; Developer ID distributed macOS application planned
- Third-party services: Clerk, Convex, Vercel, Apple notarization, GitHub Releases/update feed
- Data collected: Workspace, task, document, chat, agent, execution, and account data
- User roles: Workspace members and administrators plus resource-bound agents

## Launch Decision

- Decision: Block launch
- Highest unresolved severity: P1
- Reason: The native design is materially hardened and locally testable, but production dependencies currently report high-severity advisories and no signed/notarized updater artifact has completed the release gate.

## Executive Summary

The Mac client now bundles the shared Operate React components, styles, fonts,
and desktop route adapters locally instead of loading the website. It exposes
no Tauri command bridge to the UI, rejects navigation out of the packaged app,
disables release devtools, applies a restrictive content policy, and
cryptographically verifies native updates. The CLI uses a human-approved device
flow, stores its credential in macOS Keychain, isolates credentials by origin,
rejects insecure remote origins, and discovers the live MCP tool surface.

This is not ready to distribute. The production dependency scan reports eight
high-severity and 42 moderate dependency findings. Apple signing/notarization
and updater signing are correctly mandatory in the release pipeline, but the
required repository configuration and a clean-Mac update exercise remain
unverified. Production currently returns HSTS but no observed CSP or companion
browser hardening headers on the sign-in route. Social/enterprise Clerk flows
also need a real signed-app test because the strict webview boundary may require
a native system-auth handoff.

## Top Findings

| Severity | Finding | Affected asset | Status | Required action |
| --- | --- | --- | --- | --- |
| P1 | Production dependency scan reports 8 high and 42 moderate findings | Web application dependency graph | Open | Triage direct and transitive advisories, upgrade safely, and require a reviewed audit exception file for any residual finding |
| P1 | Signed and notarized update path has not completed end to end | macOS distribution and updater | Unverified | Configure release secrets/variables, build a draft, verify notarization and Gatekeeper, then update an older clean-Mac install |
| P2 | Production sign-in response exposes only HSTS among the checked hardening headers | Web application | Open | Add a tested CSP and route-appropriate frame, MIME, referrer, and permissions policies without breaking Clerk or embedded app surfaces |
| P2 | Federated and enterprise sign-in behavior inside the strict webview is unverified | Mac authentication | Unverified | Test every enabled Clerk strategy in a signed build; implement ASWebAuthenticationSession and an exact callback allowlist where an external IdP requires it |
| P2 | Device authorization returns a non-expiring agent API key | CLI credential lifecycle | Open | Verify revocation UX and incident response; prefer short-lived access plus rotated refresh credentials for the desktop CLI |

## Checklist Coverage

| Category | Status | Evidence |
| --- | --- | --- |
| Data and legal handling | Unverified | Legal/product data inventory was outside this implementation slice |
| Asset inventory | Partial | Web, Convex, OAuth/device routes, MCP endpoint, Mac shell, CLI, CI, and update feed identified |
| Authentication | Partial | Clerk routes and device/OAuth implementations inspected; full provider matrix not exercised |
| Authorization and tenancy | Partial | MCP rejects missing bearer credentials; existing resource-bound agent checks inspected; no cross-tenant dynamic test performed |
| Database and storage | Partial | Plaintext device credential is not stored in Convex; CLI secret is stored in Keychain |
| Input validation and injection | Partial | CLI JSON and origins validated; complete web input surface not re-audited |
| Output shaping and data leaks | Partial | CLI never prints its credential; unauthenticated manifest intentionally contains only public capability metadata |
| Secrets and configuration | Partial | Release script checks required settings and does not print values; hosted secret configuration unverified |
| Errors, logging, and monitoring | Partial | Native updater errors omit secrets; production monitoring configuration not reviewed |
| Browser, headers, CORS, and CSRF | Fail | HSTS observed; checked CSP and companion browser headers absent on sign-in response |
| Abuse, bot, and cost controls | Partial | Device flow rate-limits and slows pollers; broader production limits unverified |
| Dependency and supply chain | Fail | `npm audit --omit=dev` reports unresolved high/moderate findings; new workflow actions are commit-pinned |
| Payments, webhooks, and email | Unverified | Outside this desktop slice |
| File uploads and user-generated content | Unverified | Outside this desktop slice |
| AI, LLM, and agentic features | Partial | MCP authentication and tool discovery inspected; tool-by-tool authorization not dynamically tested |
| Deployment and release operations | Partial | Signed/notarized/update-signed draft workflow implemented but not executed with real credentials |

## Detailed Findings

### P1 - Unresolved dependency advisories

- Status: Open
- Confidence: High
- Affected asset: Production web dependency graph
- Evidence: `npm audit --omit=dev --json` reported 8 high and 42 moderate findings, including paths through Next.js/sharp/PostCSS, fast-uri/AJV, browserslist, ip-address, nanoid, Tiptap, tldraw, Hono, and qs.
- Impact: Depending on reachability, advisories include XSS, SSRF/trust-boundary bypass, file disclosure, denial of service, and cross-user response leakage.
- Safe reproduction or reasoning: Local lockfile scan only; no exploit payload was sent to production.
- Remediation: Triage reachability, upgrade non-breaking packages first, plan and test required major upgrades, and document time-bounded exceptions for unreachable transitive findings.
- Validation: A clean lockfile scan must have no P0/P1 findings unless a reviewed, expiring exception includes reachability evidence.

### P1 - Release and update chain not proven end to end

- Status: Unverified
- Confidence: High
- Affected asset: Mac application and bundled CLI distribution
- Evidence: Source now requires Developer ID, notarization, HTTPS update endpoint, embedded updater public key, and update-signing key. Those external credentials and produced artifacts were not available locally.
- Impact: Publishing without those checks would expose users to Gatekeeper warnings or an update channel that has never demonstrated authenticity and recoverability.
- Safe reproduction or reasoning: Local compile/tests passed; release script intentionally exits when configuration is absent.
- Remediation: Configure protected release environment values, restrict release approvals, publish only a draft, and exercise install/update/rollback on a clean Apple Silicon Mac and an Intel Mac if supported.
- Validation: Preserve `codesign`, `spctl`, notarization, signature, checksum, and previous-version update evidence with the release.

### P2 - Browser hardening headers are incomplete

- Status: Open
- Confidence: High for the observed response
- Affected asset: Hosted web application at `https://www.operate.to/sign-in`
- Evidence: A production HEAD response included HSTS but no observed Content-Security-Policy, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, or Permissions-Policy.
- Impact: The hosted web product has fewer browser-enforced containment layers. The native bundle has its own CSP, so this finding no longer defines its UI boundary.
- Safe reproduction or reasoning: Read-only HEAD request.
- Remediation: Design route-aware headers, generate nonces where needed, enumerate Clerk/Convex/media origins, deploy report-only CSP first, inspect violations, then enforce.
- Validation: Automated header tests plus sign-in, realtime, editor, whiteboard, media, ChatGPT widget, and Mac parity regression runs.

### P2 - Federated sign-in path is unverified under strict navigation

- Status: Unverified
- Confidence: Medium
- Affected asset: Mac sign-in
- Evidence: The Mac webview permits only Tauri's packaged application origin and denies child webviews. Clerk provider configuration and a signed-app login matrix were not available in this review.
- Impact: Email/password may work while an enabled external identity provider fails or tempts a future broad navigation exception.
- Safe reproduction or reasoning: Static flow analysis; no account credentials were used.
- Remediation: Keep the packaged-app origin gate. For providers that leave the local UI, use ASWebAuthenticationSession with PKCE and an exact universal-link/custom-scheme callback rather than loading arbitrary IdP pages in the webview.
- Validation: Successful sign-in, cancellation, stale callback, wrong state, replay, and account-switch tests for every enabled strategy.

### P2 - CLI device credential is long-lived

- Status: Open
- Confidence: High
- Affected asset: Agent API key returned by `/oauth/token` for the device grant
- Evidence: The route describes the `cua_` credential as non-expiring. The CLI protects it with Keychain and never logs it, but lifetime determines post-theft exposure.
- Impact: A stolen unlocked-user credential remains useful until server-side revocation.
- Safe reproduction or reasoning: Source inspection only; no credential was minted.
- Remediation: Confirm immediate per-agent revocation and audit history, add credential last-used visibility, and migrate desktop CLI sessions to short-lived access tokens with rotating refresh tokens where practical.
- Validation: Revoke a test agent and prove subsequent MCP calls fail immediately; test refresh replay family revocation.

## Auth Failure Case Results

| Case | Result | Evidence |
| --- | --- | --- |
| Wrong password repeated attempts | Unverified | Requires an approved test account and Clerk configuration |
| Password reset for unknown email | Unverified | Requires an approved test account and outbound-mail observation |
| Verification or magic link reused | Unverified | Requires an approved test account |
| Duplicate signup | Unverified | Requires an approved test account |
| Protected route/API without session | Pass for MCP | Unauthenticated production initialization request returned HTTP 401 with `invalid_token` |

## Secrets And Data Exposure Review

- Frontend bundle exposure: Local UI receives no Tauri command bridge and embeds only publishable Clerk/Convex configuration; full generated-bundle review remains pending.
- API response exposure: Public manifest exposes only public tool and skill metadata by design; MCP requires bearer authentication.
- Logs and analytics exposure: Native code prints updater errors but not credentials; production log sinks were not reviewed.
- Environment variable exposure: CLI token environment override is hidden in help values; release workflow secrets are passed through secret contexts and checked without printing values.
- Secret rotation needed: Unverified. Rotate immediately if any release or auth credential has ever appeared in logs or repository history.

## Infrastructure Abuse Controls

- Rate limits: Device authorization has server-side rate limiting and RFC slow-down behavior; broader inventory unverified.
- Paid API caps: Unverified.
- Usage alerts: Unverified.
- Bot protection: Clerk/Vercel posture unverified.
- Upload limits: Unverified.
- Queue/retry limits: Device CLI honors poll intervals and adds five seconds after `slow_down`; broader jobs unverified.

## Validation Evidence

- Files inspected: Tauri shell/config, OAuth device/token routes, MCP handler/proxy, agent manifest, package manifests, CI, and release scripts.
- Commands run: Rust format/check/test/clippy, native CLI build/help/live manifest, local desktop UI typecheck/production build, shell syntax checks, YAML parse, production redirect/header/MCP checks, DMG verification, and npm audit.
- Scanners reviewed: npm audit production dependency report.
- Manual probes: Canonical-host redirect, sign-in headers, unauthenticated MCP initialization.
- Tests run: 4 CLI unit tests and 2 desktop unit tests; live local-bundle app process launch after updater configuration correction.
- Packaging proof: The locally bundled shared UI compiled across 4,487 modules; the arm64 `.app` contains separate Mach-O app and CLI executables; the development DMG passed `hdiutil verify`. This unsigned artifact used placeholder public Clerk/Convex configuration and is not release evidence.
- Report validator: `validate_security_audit_report.py`.

## Unverified Areas

- Signed and notarized DMG installation, update, interruption recovery, and rollback.
- Signed-in visual parity across representative routes, dark/light mode, and narrow/wide windows.
- Clerk password, social, enterprise, MFA, reset, verification, and session-expiry flows in the Mac app.
- Complete cross-tenant authorization matrix, uploads, payments, webhooks, email, observability, backups, and incident response.
- Reachability of each dependency advisory and the full Rust advisory database.

## Remediation Plan

| Priority | Fix | Owner area | Validation |
| --- | --- | --- | --- |
| 1 | Triage and remediate high dependency advisories | Web platform | Clean production audit or reviewed expiring exceptions |
| 2 | Configure and exercise signed/notarized update release | Release engineering | Clean-Mac install and previous-version update evidence |
| 3 | Add and stage route-aware browser security headers | Web security | Automated headers plus full app regression |
| 4 | Run the Mac authentication and exact-UI parity matrix | Product/auth/release | Signed-out and signed-in screenshot/test evidence |
| 5 | Tighten CLI credential lifetime and prove revocation | Auth platform | Revocation and refresh-replay tests |

## Final Gate

- Remaining launch blockers: P1 dependency findings; no end-to-end signed/notarized/updater release evidence.
- Accepted residual risks: None accepted in this audit.
- Recommended next verification: Remediate or disposition P1 findings, configure the protected macOS release environment, create a draft artifact, then test exact UI parity and every enabled auth strategy on a clean Mac before publication.
