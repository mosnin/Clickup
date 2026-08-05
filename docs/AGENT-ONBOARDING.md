# Onboarding an agent: one command, no pasted key

The target: somebody with an agent runs one line, approves once in a browser,
and their agent is connected, briefed, and knows how to stay current. Nobody
copies a secret through a chat window.

```
curl -fsSL https://operate.to/start
```

That returns a markdown document **addressed to the agent**, not to the person.
The person's whole job is to paste that line and later click Approve.

---

## Why a device flow, not a pasted key

The current path — sign in, create an agent, copy `cua_…`, paste it into a
config — has three problems, and only the third is about convenience.

1. **The secret travels through the wrong places.** It goes into a chat
   transcript, a clipboard, often a file that gets committed. A key that has
   been in a conversation has been in a log.
2. **Consent is not informed.** You mint a key and *then* decide what the agent
   may do. The governance fields already exist (`agents.role`,
   `allowedListIds`, `dailyActionLimit`) and are set after the fact, in a
   different screen, by someone who has already stopped paying attention.
3. It is four steps and a context switch.

**OAuth 2.0 Device Authorization Grant (RFC 8628)** fixes all three, and it is
what `gh auth login`, `aws sso login` and `stripe login` already use — so the
shape is familiar to anybody who has connected a CLI to anything.

### The flow

```
agent                          operate.to                        human
  │                                 │                              │
  ├─ POST /oauth/device ───────────►│                              │
  │  {client: "claude-code"}        │                              │
  │◄── {device_code, user_code, ────┤                              │
  │     verification_uri, interval} │                              │
  │                                 │                              │
  ├─ prints: "open operate.to/link, enter WXYA-3479" ─────────────►│
  │                                 │                              │
  │                                 │◄──── visits /link, signs in ─┤
  │                                 │      (Clerk session)         │
  │                                 │                              │
  │                                 │───── consent screen ────────►│
  │                                 │      scope / role / lists /  │
  │                                 │      daily budget            │
  │                                 │◄──── Approve ────────────────┤
  │                                 │                              │
  ├─ POST /oauth/token ────────────►│  (polling at `interval`)     │
  │◄── {api_key, agent_id, mcp_url} ┤                              │
```

The key is **minted at approval**, by the existing `agentKeys.createKey` Node
action, and returned once to the poller. It is never rendered on screen and
never enters the human's clipboard.

### What makes it secure rather than just standard

- **`user_code` is short and human-transcribable, `device_code` is not.** The
  code the human types identifies a pending request; it does not authorise
  anything on its own. Approval is bound to their Clerk session.
- **The consent screen names the blast radius.** Not "allow?" but *which space,
  which role, which lists, how many actions a day* — the four governance fields
  the schema already has. This is the honest version of consent and it costs
  nothing to build because the fields exist.
- **Codes expire (10 min) and are single-use.** Poll after approval returns the
  key exactly once; a replayed `device_code` gets `invalid_grant`.
- **Rate-limited polling.** The `interval` is returned and enforced;
  `slow_down` on a too-eager poller, per RFC.
- **Phishing resistance.** The human approves on operate's own domain, having
  arrived there by typing the address, not by following a link the agent gave
  them. That is the property the pasted-key flow cannot have.

### Tables

One new table. Everything else already exists.

```ts
agentAuthRequests: defineTable({
  deviceCodeHash: v.string(),   // SHA-256; never store the code
  userCode: v.string(),         // WXYA-3479, uppercase, no ambiguous glyphs
  clientName: v.string(),       // "claude-code", for the consent screen
  status: v.union(
    v.literal("pending"),
    v.literal("approved"),
    v.literal("denied"),
    v.literal("claimed"),       // key issued; terminal
  ),
  approvedByClerkId: v.optional(v.string()),
  agentId: v.optional(v.id("agents")),
  expiresAt: v.number(),
  createdAt: v.number(),
})
  .index("by_user_code", ["userCode"])
  .index("by_device_hash", ["deviceCodeHash"])
```

`deviceCodeHash` rather than the code, for the same reason `agentKeys` stores a
hash: a database read must not be enough to impersonate the agent. The pure-JS
SHA-256 in `_agentAuth.ts` already exists and works in the default runtime.

---

## What `/start` returns

A generated document, **never hand-written prose**. This matters: the
`propose_screen` tool currently describes the available panels in a hardcoded
string, and that string has already drifted from `PROJECT_WIDGETS` — it lists
nine where there are eleven. Any document that describes the system by hand
will drift the same way. So `/start` reads the live registry at request time.

Sections, in the order an agent needs them:

1. **What this is** — five lines. Tasks, docs, goals and chat, shared by people
   and agents, where an agent is a first-class principal rather than an
   integration.
2. **Connect** — the device flow above, as exact `curl` calls the agent can run.
3. **Write your config** — the MCP block for the detected client, from
   `src/lib/connect-snippet.ts`, which already generates these for Claude,
   Cursor and raw HTTP.
4. **Your first call is `brief`** — not `whoami`. `brief` returns accepted
   decisions, open questions and governance limits in one call, which is the
   difference between an agent that relitigates settled questions and one that
   does not. (It is currently absent from the MCP `instructions` string, from
   `whoami.firstSteps`, and from the `collaboration-protocol` skill — three
   string edits, worth doing regardless of this feature.)
5. **Skills to install** — the built-in playbooks from `BUILTIN_SKILLS`
   (`collaboration-protocol`, `sprint-planner`, `daily-standup`,
   `backlog-triage`, `execution-plan-compiler`, `project-kickoff`,
   `progress-reporter`), each with its slug, version and one-line purpose.
6. **Staying current** — the manifest, below.

---

## Staying current: one endpoint, one number

```
GET /api/agent/manifest
→ 200 {
    apiVersion: 1,
    mcpUrl: "…/api/mcp",
    tools:  { count: 180, hash: "sha256:…", names: [...] },
    skills: { install: "…/install/skills",
              items: [{ slug: "operate-plan", sha256: "…", url: … }, …] },
  }
  ETag: "…"
```

The agent stores the `ETag` and sends `If-None-Match` on boot and after any
unexpected 4xx. A `304` is the common case and costs almost nothing. A `200`
means something changed, and the body says exactly what — a new tool, or a
skill whose digest is not the one the agent installed.

**Why a hash over the tool list and not a version number:** a version number is
maintained by a person and therefore forgotten. A hash of the registered tool
names cannot be forgotten, and it changes exactly when the surface changes.
Same argument as generating `/start` rather than writing it.

`names` ships alongside `count` because a count cannot distinguish "one tool
added" from "one added and one removed" — and the second case is the one where
the agent's stored instructions are actively wrong rather than merely
incomplete.

**Skills are versioned by content digest for the same reason.** The plan here
was a `version` column; the shipped answer is the SHA-256 of the skill file,
because the argument against a hand-maintained version number does not get
weaker when it is applied to a skill instead of a tool list. `/install/skills`
already computed exactly these digests to verify what it writes, so the
installer and the manifest now read the same function and cannot disagree
about what "current" means.

---

## Taking it further

Three things worth building once the above works, roughly in order of value:

**Push, not poll.** An agent that registers a `notifyUrl` (the field exists,
HMAC-signed via `X-Ping-Signature`) can be told when a skill it installed
changes, instead of asking. The webhook fan-out in `emitEvent` already does
this for work events; a `skill.updated` event type is a one-line addition.

**A revocation story the human can see.** The Agents page lists keys; it should
also list *authorisations* — which client, approved when, last seen, and a
Revoke that kills the key and ends the session. Device flow makes this natural
because each authorisation is a row rather than an anonymous key.

**Scoped keys per project.** `allowedListIds` already fences an agent to
specific lists. The consent screen should default to the narrowest scope that
makes sense — the project the human was looking at when they opened `/link` —
rather than the whole workspace. Consent screens that default to "everything"
train people to stop reading them.

---

## What shipped

| Piece | Where |
| --- | --- |
| `agentAuthRequests` table | `convex/schema.ts` |
| create / approve / deny / claim | `convex/agentAuth.ts` |
| Device authorization endpoint | `src/app/oauth/device/route.ts` |
| Device grant on the token endpoint | `src/app/oauth/token/route.ts` |
| Consent screen | `src/app/link/` |
| Manifest | `src/app/api/agent/manifest/route.ts`, `src/lib/agent-manifest.ts` |
| `/start` | `src/app/start/route.ts` |
| Homepage command | `src/components/marketing/start-command.tsx` |
| Tests | `tests/agent-device-flow.test.ts`, `agent-device-http.test.ts`, `agent-manifest.test.ts` |

Three things went differently from the plan above, all for the same reason —
the thing already existed and a second copy would have been the bug.

**The device flow lives at `/oauth/*`, not `/api/agent/*`.** The plan assumed
a parallel pair of endpoints; the repo already had a compliant OAuth 2.1
server with discovery metadata, and RFC 8628 says the device grant belongs on
the existing token endpoint. So `/oauth/device` was added,
`grant_type=urn:ietf:params:oauth:grant-type:device_code` was added to
`/oauth/token`, and `.well-known/oauth-authorization-server` advertises both
— which means a client can *discover* the flow instead of being told about it.

**The key is minted in the route, not at approval.** Minting at approval
would mean storing a plaintext key for the ten minutes until the poller
collects it. Instead the route generates it and passes only the hash into
Convex — the same shape `oauth.ts` already uses for authorization codes — so
the plaintext never exists in the database at any point.

**Skills are digested, not version-numbered.** See above.

### The part that needs watching

`src/lib/mcp-tool-names.ts` is a transcription of the tool definitions in
`src/app/api/[transport]/route.ts`, because a Next route file may only export
HTTP handlers and the names cannot be exported from where they are declared.
That is exactly the drift this document was written to avoid, so it is not
trusted to good intentions: `tests/agent-manifest.test.ts` parses the route
file and fails, by name, when the two disagree. The same technique pins the
`DeviceRequestState` union across the Convex/Next boundary at compile time.

`/start` must continue to describe only what is built. A document that tells
an agent to run a flow that does not answer is worse than no document, and it
is the same class of failure as a pricing page selling a plan nobody can buy.
