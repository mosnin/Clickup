# Chat dashboard — architecture decisions

The Chat dashboard is a second, complete application living beside the Work
dashboard, modelled feature-for-feature on [Buzz](https://github.com/block/buzz)
(Block, Apache 2.0). This file records the decisions every later phase builds on.
Change one of these and the phase plan changes with it.

## D1 — Substrate: Convex, carrying a real Nostr event layer

Buzz's substrate is a self-hosted Nostr relay (Rust + Postgres + Redis, NIP-01
over WebSocket). We do not run that relay. We keep the *semantics* — one
append-only log of kind-tagged, signed events — and store it in Convex, so the
Chat side gets real-time subscriptions, our existing authz, and a free bridge to
Work.

Events are genuinely Nostr-shaped, not Nostr-flavoured: `{id, pubkey, kind,
created_at, tags, content, sig}`, where `id` is the SHA-256 of the NIP-01
canonical serialization and `sig` is a BIP-340 Schnorr signature over it. An
event exported from our log verifies in any Nostr tool.

## D2 — Signing happens inside the mutation

Verified before writing any code (`@noble/curves@1`, `@noble/hashes@1`):

- The libraries are pure JS — no Node built-ins, no WASM — so they run in
  Convex's default V8 runtime, not just in `"use node"` actions.
- `schnorr.sign(id, sk, aux)` with an explicit 32-byte `aux` is deterministic and
  needs no `globalThis.crypto`. Deterministic aux is valid BIP-340. Convex
  mutations forbid randomness; this is exactly the escape hatch we need.

Consequence: **the event is signed in the same transaction that writes it.**
There is no "write now, sign later" scheduler hop, so an unsigned event can never
be observable. Only key *generation* needs a `"use node"` action, because that
does need a CSPRNG.

## D3 — Keys

One secp256k1 keypair per principal — every human and every agent. Minted in a
Node action; the private key is stored server-side and never sent to the browser.
Signing is server-side, in the mutation. `nsec` import/export is a later phase,
not a blocker.

This mirrors Buzz's model where an agent is scoped *by identity*, not by
permission flags: an agent's events are signed by the agent's own key and are
distinguishable forever, in the log, without trusting a boolean column.

## D4 — Community = workspace

A Buzz "community" maps to one of our workspaces; a user's personal space is
their private community. The tenancy boundary is therefore the boundary
`convex/_authz.ts` already enforces, so channel/message access checks reuse
`canAccessSpace` rather than inventing a second answer to "may this person see
this".

## D5 — Look: Buzz's structure, our primitives

Buzz's information architecture, chrome and density, drawn with our bento
surfaces, motion primitives and the layered appearance system — so a user's
personal accessibility settings (type size, motion, contrast, body typeface)
still apply in Chat, and the two dashboards read as one product in two modes.
The Chat theme is scoped to its route subtree; the Work dashboard's appearance is
untouched.

## D6 — Huddles: OPEN. The original assumption was wrong.

This was written as "WebRTC mesh, matching Buzz". Buzz does not use WebRTC.
`grep -rniE "RTCPeerConnection|webrtc" over the whole repo returns zero hits.

What Buzz actually does: a huddle is a room on the relay's own WebSocket
(`/huddle/{id}/audio`), with a custom binary frame (8-byte big-endian header:
seq, 48 kHz timestamp, level in dBov, flags), Opus at 32 kbps with DTX, a
per-peer NetEq jitter buffer and a per-peer player on the client, NIP-42 auth on
connect, and a roster handshake. No SFU, no TURN, no ICE — because the relay is
already a stateful server every client is connected to, so it just forwards
audio.

That is precisely what we do not have. Convex has no persistent binary
WebSocket endpoint for a custom protocol, so this is the one Buzz subsystem
that cannot be recreated on our substrate as designed.

**Resolved: a managed SFU** (LiveKit or Daily) carries the audio; we carry
identity, the roster, and every lifecycle event. Their infrastructure scales
past what a mesh can do and past what we would want to operate, and it keeps the
audio path out of a service we would otherwise have to run, monitor and page
someone about. The cost is a paid third-party dependency that sees call traffic,
which is a real trade and is why it was asked rather than assumed.

Everything above the transport is ours and matches Buzz exactly: a huddle is
still a room announced by signed events on the log, membership is still the
channel's membership, an agent still joins the same way a person does. The SFU
is a pipe for audio frames, not the source of truth for who is in the room — so
switching provider later, or replacing it with our own service, changes one
adapter.

Everything else in the huddle phase — lifecycle events and their kinds, the
roster, the bar UI and every control, speaking indicators, push-to-talk,
reactions, transcript, add-an-agent — is transport-independent and gets built
either way.

## D7 — Scope

All four subsystem clusters are in scope: core comms; agents in-room; workflows +
projects + pulse; huddles + media. All four bridges are in scope: tasks ↔
channels, one identity and one agent fleet, unified inbox, shared search and
activity.

## D9 — An agent's turn runs on the agent's own runtime

Buzz's model, kept: a mention is pushed to the agent's runtime, and the agent
answers over the tools it already has. We do not run the turn server-side.

We already have every piece — `agents.notifyUrl` with HMAC-signed pings, the
SSRF guard, API keys, the hosted MCP server, per-agent budgets and governance —
so an in-room turn is a mention that pings a runtime, and a reply is an ordinary
MCP write signed by the agent's own key.

What this deliberately costs: a newly created agent does nothing until somebody
runs a harness for it. A server-side fallback would have made the room answer
out of the box, and it would also have meant an agent that cannot use any tool
that lives on your machine — which is most of the reason Buzz's harness exists at
all. The silence is the honest state, and the connect flow should say so rather
than look broken.

## D10 — A desktop app, wrapping the hosted app

Buzz ships a Tauri desktop client. We ship one too, on the same remote-web-app
pattern `capacitor.config.ts` already uses for iOS and Android: the shell renders
the deployed URL, so Convex realtime and the Clerk session behave exactly as they
do on the web and a change reaches users without an app-store round trip.

Not in scope, and each for the same reason — they solve offline sovereignty over
your own copy, which a hosted product answers differently: the local SQLite
archive, the identity archive, mesh compute, and on-device speech models
(hundreds of megabytes of weights per client).

## D8 — Isolation from concurrent work

Another agent is building the dynamic-UI/panel/canvas system on `main`. Chat code
lives in its own namespaces (`convex/buzz/*`, `src/app/chat/*`,
`src/components/chat/*`, `src/lib/buzz/*`). Edits to shared files
(`convex/schema.ts`, `src/app/globals.css`, `src/components/dashboard/sidebar.tsx`,
`package.json`) are minimal, additive and append-only.

## D11 — Two applications, not one merged one

The Work dashboard is the existing product, unchanged — including its own
`/dashboard/chat`, `convex/chat.ts` and `convex/channels.ts`. The Chat dashboard
is Buzz, built fresh on `convex/buzz/*`. Nothing migrates, nothing is replaced,
and the Work side is not refactored to make room.

This was asked as a four-way question (replace it, keep both, read both stores,
replace everything including comments) and the answer was the simplest reading:
two dashboards, one switcher at the top of the sidebar.

It is also the lowest-risk answer available. Replacing the Work chat would mean
a migration and edits across surfaces that currently work, in files a concurrent
build may be standing in. Two applications joined by a switcher and a bridge
means Chat can be built to completion without the Work product changing shape
underneath anyone.

The duplication is real and accepted: two message stores, two unread counts.
The bridge (C12) makes them pass data in real time; it does not merge them.
