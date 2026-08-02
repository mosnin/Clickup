# Buzz parity spec 04 — Voice huddles, media, canvases, archives

Rebuild specification derived from a read of `github.com/block/buzz`. Everything below is
described in enough detail to reimplement without the source. File references are
`path:symbol`.

Buzz is a Nostr-shaped team chat: every durable action is a signed Nostr event with a
`kind` integer, stored by a self-hosted relay (`crates/buzz-relay`) in Postgres, with
blobs in S3/MinIO. The desktop app is Tauri v2 (React 19 + TS webview, Rust backend). The
Rust backend owns anything that touches the network, the filesystem, or real-time audio;
the webview owns UI and the microphone capture graph only.

---

## Part 1 — Voice huddles

### 1.1 Mental model

A **huddle** is an ephemeral *channel* plus a *WebSocket Opus audio room* hosted by the
relay. There is **no WebRTC, no SFU, no TURN, no ICE, and no peer-to-peer path anywhere in
Buzz.** The relay is a dumb Opus frame forwarder; every client keeps exactly one WS to it.

```
parent channel  --start_huddle-->  ephemeral channel (kind 9007, ttl=3600)
                                   + kind 48106 guidelines posted into it
                                   + kind 9000 add-member per invited agent
                                   + kind 48100 "huddle started" posted to PARENT
other clients   --join_huddle-->   WS wss://<relay>/huddle/{ephemeral_id}/audio
any client      --leave_huddle-->  relay emits 48102; last human triggers 48103 + archive
```

The **ephemeral channel id is the huddle session id**, and also the audio room id and the
Redis lease key in multi-pod deployments.

Source of truth for the whole state machine: `desktop/src-tauri/src/huddle/mod.rs`,
`desktop/src-tauri/src/huddle/state.rs`.

### 1.2 Event kinds

Declared in `crates/buzz-core/src/kind.rs` and mirrored in
`desktop/src/shared/constants/kinds.ts`.

| Kind | Name | Signer | Posted to | Content | Tags |
|------|------|--------|-----------|---------|------|
| `9007` | create channel | client | — | `""` | `h`=ephemeral uuid, `name`, `visibility=private`, `channel_type=stream`, `ttl=3600` |
| `9000` | add member | client | ephemeral + parent | `""` | member pubkey, role `bot` for agents |
| `48100` | `KIND_HUDDLE_STARTED` | huddle creator | **parent** channel | `{"ephemeral_channel_id":"<uuid>"}` | `["h", parent_channel_id]` |
| `48101` | `KIND_HUDDLE_PARTICIPANT_JOINED` | **relay** | parent channel | same JSON | `["h", parent]`, `["p", participant_pubkey]` |
| `48102` | `KIND_HUDDLE_PARTICIPANT_LEFT` | **relay** | parent channel | same JSON | `["h", parent]`, `["p", participant_pubkey]` |
| `48103` | `KIND_HUDDLE_ENDED` | client | parent channel | same JSON | `["h", parent]` |
| `48106` | `KIND_HUDDLE_GUIDELINES` | creator | **ephemeral** channel | voice-mode prompt text | `["h", ephemeral_id]` |
| `24810` | `KIND_HUDDLE_REACTION` | any participant | ephemeral channel | the emoji | `["h", eph]`, `["reaction", emoji]`, `["sender_name", name]`, optional `["emoji", shortcode, url]` |
| `9` / `40002` | stream message | agent or STT | ephemeral channel | text | `h` + `p` tags |
| `22242` | NIP-42 auth | client | (WS only, never stored) | `""` | `["relay", url]`, `["challenge", nonce]` |

Builders: `desktop/src-tauri/src/events.rs:build_huddle_event`,
`:build_huddle_started`, `:build_huddle_ended`, `:build_huddle_guidelines`,
`:build_create_channel`, `:build_add_member`, `:build_archive`, `:build_leave`.

Notes that matter:

- `build_huddle_event` validates **both** channel ids as UUIDs before building. The
  content is always a JSON object containing at least `ephemeral_channel_id`.
- 48101/48102 are **relay-signed**, so `event.pubkey` is the relay, not the participant.
  The participant identity lives only in the `p` tag. Every consumer must read
  `tags.find(t => t[0] === "p")?.[1] ?? event.pubkey`
  (`desktop/src/features/huddle/components/HuddleIndicator.tsx`, `HuddleAttachment.tsx`).
- 48100–48103 are in `CHANNEL_EVENT_KINDS` (so they stream into a channel subscription)
  but are in `NON_CONVERSATIONAL_UNREAD_KINDS` (so they never produce an unread badge).
  Only 48100 is in `CHANNEL_TIMELINE_CONTENT_KINDS` — it renders as a card row; 48101–3
  are invisible overlays.
- 48100 messages cannot be edited, deleted, or reacted to
  (`desktop/src/features/messages/lib/canManageMessage.ts`).
- Kinds requiring an `h` tag are enforced relay-side in
  `crates/buzz-relay/src/handlers/ingest.rs:requires_h_channel_scope`.

### 1.3 Client phase machine

`desktop/src-tauri/src/huddle/state.rs:HuddlePhase` =
`Idle | Creating | Connecting | Connected | Active | Leaving`.

- `Idle → Creating` (start) or `Idle → Connecting` (join). Starting/joining while not
  `Idle` returns the error `"cannot start huddle: already in phase {:?}"`. The frontend
  treats exactly that message as **benign** and swallows it
  (`HuddleContext.tsx:isRedundantHuddlePhaseError`).
- `Creating/Connecting → Connected` once the relay work succeeds. `emit_huddle_state_changed`
  fires a Tauri event `huddle-state-changed` carrying the serialized `HuddleState`.
- `Connected → Active` only when the webview confirms it has microphone + AudioWorklet, via
  `confirm_huddle_active` (idempotent; no-op if already `Active`).
- Anything → `Leaving` → `Idle` via `teardown_huddle`.

`HuddleState` (serialized to the webview) fields: `phase`, `parent_channel_id`,
`ephemeral_channel_id`, `participants: Vec<String>` (all pubkeys incl. humans),
`agent_pubkeys: Vec<String>`, `is_creator`, `tts_enabled`, `transcription_enabled`,
`voice_input_mode`. Non-serialized runtime fields: `audio_ws_cancel` (CancellationToken),
`audio_relay_pcm_tx`, `stt_pipeline`, `tts_pipeline`, `tts_active`/`tts_cancel`/
`tts_starting`/`stt_starting`/`ptt_active` atomics, `huddle_generation: u64`,
`session_generation: Arc<AtomicU64>`, `transcription_user_controlled: bool`,
`last_agent_refresh`.

**Two independent generation counters** — this is load-bearing:

- `huddle_generation` bumps once per start/join attempt (`begin_huddle_lifetime`). It
  answers "does this async result still belong to the huddle that started it?"
  (`is_current_huddle`, `owns_huddle_lifetime`). A rejoin to the *same* channel gets a new
  generation, so a stale result from the previous session cannot commit or reset.
- `session_generation` bumps on every teardown *and* every STT pipeline replacement. The
  transcription posting task captures it at spawn and exits the loop the moment it
  differs, so a torn-down huddle can never post one more transcript segment.
- `reset_preserving_generation()` resets to `Default` but preserves both counters **and**
  `tts_enabled` (an installation-global preference that must survive a huddle).
- `invalidate_transcription_pipeline()` bumps `session_generation` *and replaces the
  `stt_starting` Arc*, so a stale constructor cannot clear the replacement's sentinel.

### 1.4 `start_huddle` (creator path)

`desktop/src-tauri/src/huddle/mod.rs:start_huddle(parent_channel_id, member_pubkeys, channel_name)`.

1. Validate at the IPC boundary: `member_pubkeys.len() <= MAX_HUDDLE_AGENTS` (20,
   `huddle/relay_api.rs`), each pubkey is 64 lowercase-hex chars
   (`relay_api.rs:validate_pubkey_hex`), dedupe preserving order.
2. Transition `Idle → Creating`, store `parent_channel_id`, take a generation.
3. Mint `ephemeral_uuid = Uuid::new_v4()`. Channel name: caller-supplied name normalized
   (collapse whitespace, truncate to 80 chars) or fallback `huddle-<first 8 hex of uuid>`
   (`mod.rs:normalize_huddle_channel_name`). Callers build the human name with
   `desktop/src/features/huddle/lib/huddleChannelName.ts:buildHuddleChannelName` —
   `"<channel> huddle"` for channels, `"Alice <> Bob huddle"` (self first, first names
   only) for DMs.
4. Publish, in this exact order:
   1. `kind 9007` create-channel, private / stream / **ttl 3600**.
   2. `kind 48106` guidelines into the *ephemeral* channel — **before** adding agents,
      because agents auto-subscribe on the `kind 9000` membership notification and may
      complete EOSE before a later-posted guidelines event exists. Best-effort (failure
      logged, huddle continues).
   3. `kind 9000` add-member per invited pubkey, role `"bot"`. **Only successfully added
      pubkeys are kept** — a policy rejection silently drops that agent rather than
      failing the huddle, and rejected agents are never p-tagged on transcripts.
   4. `kind 48100` huddle-started to the *parent*.
5. On any failure: archive the orphaned ephemeral channel (`build_archive`), reset state
   if this attempt still owns `Creating`.
6. On success, commit under lock (only if still the owning generation): phase `Connected`,
   `is_creator = true`, `agent_pubkeys = successful_agents`, `participants = [self, ...agents]`,
   run `maybe_auto_enable_transcription_for_agents()`.
7. `post_connect_setup` (see §1.7). Audio relay failure here is **fatal** — the huddle is
   ended, archived, and rolled back.

### 1.5 `join_huddle`

`mod.rs:join_huddle(parent_channel_id, ephemeral_channel_id)`. Much simpler: `Idle →
Connecting → Connected`, seed `participants = [self]`, then `post_connect_setup`. Joiners
never add agents (the creator did). The relay emits 48101 when the audio WS authenticates,
so no client-side join event is published.

### 1.6 `leave_huddle` / `end_huddle`

`leave_huddle` (`mod.rs`):

1. Phase → `Leaving`.
2. **Auto-end check, performed before removing self:** `count_human_members(ephemeral)` —
   fetch kind 39002 members and count non-`bot` roles. If `<= 1`, *we* are the last human:
   emit 48103, remove all bot members, archive the channel (`emit_end_and_archive`).
   Otherwise just publish a `leave` event for self.
   **On a fetch failure the count defaults to `2`, not `1`** — a transient REST error must
   never end everyone's huddle.
3. `teardown_huddle`.

`end_huddle(force)` is creator-only (`is_creator`), with a `force` escape hatch the UI is
expected to gate behind a confirmation for the "creator vanished" case.

`teardown_huddle` order is exact and matters:

1. Bump `session_generation` **first** (invalidates in-flight transcription immediately).
2. Take `stt_pipeline`, `tts_pipeline`, `audio_ws_cancel` out of the state.
3. **Cancel the token before dropping `audio_relay_pcm_tx`.** If the sender is dropped
   first, the send task sees `None` from `recv()` and exits before `is_cancelled()` is
   true, which emits a spurious `huddle-audio-disconnected` on an intentional teardown.
4. `reset_preserving_generation()`, drop the lock, *then* `shutdown()` and drop the
   pipelines outside the lock (thread joins block ~200 ms on ONNX).
5. `emit_huddle_state_changed`.

Frontend `leaveHuddle` (`HuddleContext.tsx`) runs `disconnectMedia()` (bump token, stop
worklet, stop mic track, clear state) and then always calls `leave_huddle` — it is
idempotent in Rust, so a provider remount can never leave Rust holding an active huddle.
It returns `false` if the backend call failed so the bar stays visible for a retry.

### 1.7 `post_connect_setup`

`desktop/src-tauri/src/huddle/pipeline.rs:post_connect_setup`:

1. Fetch authoritative agent pubkeys (`role=bot`) and all members from the relay's kind
   39002 event; refresh `participants`. On fetch failure the *previous* list is preserved
   (STT p-tags must not silently disappear).
2. `maybe_auto_enable_transcription_for_agents()`.
3. Kick off voice model downloads (TTS always, STT only if transcription is on).
4. `connect_audio_relay` — **fatal on failure**.
5. Start TTS pipeline, then STT pipeline (both best-effort; if models aren't downloaded
   the huddle runs voice-only and a hot-start timer picks them up later).

Every step re-checks `is_current_huddle(ephemeral_id, generation)` and returns
`PostConnectOutcome::Stale` rather than clobbering a replacement huddle.

### 1.8 Signalling — how the audio session is negotiated

There is no offer/answer/ICE. Signalling is (a) Nostr events in the event log for
*presence and lifecycle*, and (b) a small JSON handshake on the audio WebSocket for
*media routing*. Client: `desktop/src-tauri/src/huddle/relay_api.rs:connect_audio_relay`.
Server: `crates/buzz-relay/src/audio/handler.rs:handle_audio_connection`.

```
client                                            relay
  |  GET wss://<relay>/huddle/{channel_id}/audio    |
  |------------------------------------------------>|   (Host header binds the tenant/community)
  |<-- {"type":"challenge","challenge":"<nonce>"} ---|   (5 s AUTH_TIMEOUT)
  |                                                  |
  |-- {"type":"auth",                                |
  |     "event": <signed kind 22242 nostr event      |
  |               with ["relay",url] ["challenge",n]>|
  |     "parent_channel_id": "<uuid|null>",          |
  |     "protocol_version": 2 } ------------------->|
  |                                                  |  verify sig; ensure_membership();
  |                                                  |  reject if channel archived;
  |                                                  |  room.add_peer -> peer_index u8
  |<-- {"type":"joined","pubkey":..,"peer_index":n,  |
  |      "peers":[{pubkey,peer_index},...]} ---------|  (also broadcast to existing peers)
  |                                                  |  relay publishes kind 48101
  |== binary frames both directions ================>|
  |<-- {"type":"roster","peers":[...]}   (mesh re-sync)
  |<-- {"type":"left","peer_index":n}
  |<-- {"type":"error","code":"...","message":"..."}
  |<-- Ping (30 s heartbeat; 3 missed pongs => disconnect)
```

Error codes returned as `{"type":"error","code":...}`: `unsupported_version`
(+`current_version`), `upgrade_required` (+`pinned_version`, `requested_version`),
`room_full`, `room_ended`, `huddle_owner_unreachable`, plus a plain
`{"type":"error","message":"huddle has ended"}` for archived channels.

Client handshake constraints: 5 s timeout waiting for `challenge`, 5 s waiting for
`joined`. Both timeouts abort the connection with a descriptive error.

`ensure_membership` (`handler.rs`) loads the channel, rejects archived channels *first*
(so an auto-ended huddle can never be rejoined), and for an ephemeral channel (`ttl_seconds`
is set) requires the client-supplied `parent_channel_id` to be corroborated by a
**creator-signed kind 48100 link event** in the DB (`huddle_started_link_exists`) — the
client's claimed parent is never trusted. Members are auto-added to ephemeral channels.

### 1.9 Audio wire protocol

`desktop/src-tauri/src/huddle/wire.rs` (encode+parse) and
`crates/buzz-relay/src/audio/wire.rs` (parse only — the relay never encodes or re-encodes).

- **v1 (legacy, still admitted into v1-pinned rooms):**
  client→relay `<opus_bytes>`; relay→client `<peer_index: u8><opus_bytes>`.
- **v2 (current, `PROTOCOL_VERSION = 2`):**
  client→relay `<header: 8 bytes><opus_bytes>`;
  relay→client `<peer_index: u8><header: 8 bytes><opus_bytes>`.

Header, 8 bytes, **big-endian / network byte order**:

| Bytes | Field | Type | Meaning |
|-------|-------|------|---------|
| 0..2 | `seq` | u16 | wrapping sequence, +1 per packet (wraps every ~21.8 min at 50 Hz) |
| 2..6 | `ts_48k` | u32 | RTP-style 48 kHz media time, +960 per 20 ms frame |
| 6 | `level_dbov` | i8 | RMS in dB relative to full scale, canonical range `-127..=0` |
| 7 | `flags` | u8 | bit 0 = `FLAG_DTX` (0x01); all other bits reserved and MUST be ignored |

Rules:

- Header is fixed-size with **no extension mechanism**. New fields require a v3 and a new
  pin.
- Version is negotiated in the auth JSON, never in `flags`. A room is **pinned to the
  first joiner's version**; a mismatched joiner is rejected with `upgrade_required`
  (`crates/buzz-relay/src/audio/room.rs:AdmissionGuard.pinned`). Mixing v1 and v2 in one
  room would silently corrupt decode because the relay forwards payloads opaquely.
- `level_dbov` is client-authored telemetry: out-of-range values are **clamped to -127,
  never cause the frame to be dropped**, and MUST NOT feed any trust decision (admission,
  moderation, kicks). It exists for logs and speaker hints only.
- `wire.rs:audio_level_dbov(&[f32]) -> i8` computes it: RMS → `20*log10(rms)`, clamped;
  empty or silent → `-127`; full scale → `0`. Computed from **pre-encode PCM**, because
  an Opus DTX comfort packet is 1–2 bytes and its size says nothing about level.
- The sender sets `FLAG_DTX` when the encoded packet is `<= 2` bytes, so the receiver can
  exclude comfort noise from speaker detection without parsing Opus.

### 1.10 Client capture pipeline (webview → Rust → relay)

```
MediaStreamTrack (getUserMedia, 48 kHz, echoCancellation+noiseSuppression)
  → AudioContext(sampleRate: 48000)
  → MediaStreamSource → GainNode → AudioWorkletNode("stt-tap-processor")
       worklet accumulates exactly 960 f32 samples (= one 20 ms Opus frame)
       postMessage(Float32Array, [transfer]) — zero copy
  → main thread: __TAURI_INTERNALS__.invoke("push_audio_pcm", Uint8Array view)  [raw binary IPC]
  → Rust push_audio_pcm: fan out to (a) STT pipeline, (b) audio relay encoder (try_send)
  → encoder task: chunks of 960 f32 → opus::Encoder(48k, Mono, Voip, 32 kbps, DTX on)
       → 8-byte v2 header + payload → WS binary frame
```

Files: `desktop/src/features/huddle/lib/audioWorklet.ts:setupAudioWorklet`,
`desktop/public/worklet.js:SttTapProcessor`, `desktop/src-tauri/src/huddle/mod.rs:push_audio_pcm`,
`desktop/src-tauri/src/huddle/relay_api.rs:audio_relay_pipeline`.

Details:

- The typed `@tauri-apps/api` has no raw-binary invoke, so `audioWorklet.ts` reaches into
  `window.__TAURI_INTERNALS__.invoke` — the single call site that depends on Tauri
  internals, deliberately isolated.
- `push_audio_pcm` caps a batch at `MAX_AUDIO_BATCH_BYTES = 100 KB` (a 100 ms 48 kHz mono
  f32 batch is ~19 KB) and rejects larger, so a malformed IPC call can't allocate
  unbounded. Bytes are dropped silently when no pipeline is active.
- PCM handoff is **fire-and-forget** (no `await`) so slow Rust never applies backpressure
  to the audio thread; Rust uses `try_send` and drops on a full queue.
- The worklet's 960-sample buffer assumes a 48 kHz `AudioContext`. `getUserMedia` requests
  `sampleRate: 48000` for exactly this reason. A partial buffer at disconnect (< 960
  samples) is dropped — losing ~20 ms at hangup is imperceptible.
- PTT gating lives **in the worklet**: `port.postMessage({type:"ptt", active})` sets
  `transmitting`; when false the worklet discards input and resets its buffer offset so no
  stale audio is transmitted on the next press.
- `AudioWorkletHandle` exposes `stop()`, `setTransmitting(bool)`, `setMode(mode)`,
  `setGain(0..1)`. `setMode("voice_activity")` immediately opens the mic;
  `setMode("push_to_talk")` immediately gates it. **In VAD mode `ptt-state` events are not
  forwarded to the worklet at all**, so an accidental Ctrl+Space cannot mute you.

### 1.11 Receive pipeline (playout)

`desktop/src-tauri/src/huddle/playout.rs:run_playout_recv_loop` and
`desktop/src-tauri/src/huddle/jitter.rs`.

```
WS binary [peer_index | header | opus]
  → per-peer PeerJitterBuffer (neteq crate, 48 kHz mono, custom Opus AudioDecoder)
       insert_packet(seq, ts_48k, opus_bytes)
  → 10 ms tokio tick → jitter.get_audio() -> 480 f32 samples (+ VAD flag)
  → per-peer rodio::Player  →  device Mixer (sums concurrent speakers)  →  cpal output
```

- **One `NetEq` + one `rodio::Player` per remote peer.** A single shared `Player` is a
  FIFO queue, so 3+ simultaneous speakers serialized into one voice that flipped speakers
  every 20 ms with unbounded queue growth. This is the single most important structural
  fact in the playout path.
- NetEq config: 48 kHz mono, `MIN_DELAY_MS = 40`, `MAX_DELAY_MS = 200`,
  `MAX_PACKETS_IN_BUFFER = 50`, synthetic SSRC = `peer_index`, payload type 111
  (arbitrary; only used to dispatch to the registered decoder), `duration_ms = 20`.
  Decoding uses `opus::Decoder::decode_float(..., fec=false)` — receive-side FEC is not
  implemented.
- Timers: playout tick 10 ms with `MissedTickBehavior::Delay` (a dropped tick would leave
  the mixer starved and produce audible silence); speaker tick 500 ms with `Skip`.
- **Idle-peer grace** (`IDLE_PEER_GRACE = 500 ms`): NetEq emits a frame on *every*
  `get_audio` (expand/silence when empty), so a peer that vanished without a `left`
  message would queue 100 silence buffers/sec forever. A peer is "active" if it sent a
  packet within 500 ms **OR** its jitter buffer is non-empty. Inactive peers still get
  `get_audio()` called (to advance NetEq's clock) but the result is not enqueued.
- **Drift bound** `PLAYOUT_QUEUE_HIGH_WATER = 4` frames (40 ms): the producer is a tokio
  10 ms interval, the consumer is the cpal callback at hardware rate; before each append,
  if the player queue is already ≥ 4 the oldest frame is dropped with `skip_one()`.
  Without this, clock skew accumulates as monotonically growing latency.
- Control messages update `index_to_pubkey`. On `joined`, if a `peer_index` is reused with
  a *different* pubkey, the old `PeerSlot` is destroyed so NetEq state doesn't carry over.
  On `roster` (mesh re-sync), any index whose identity changed is flushed and the map is
  replaced wholesale. On `left`, the slot is dropped (which detaches its queue from the
  mixer).
- `Ping` frames are answered with `Pong` using the *shared* `ws_tx` mutex, locked briefly
  and never held across the audio fast path.

**Active speaker indicator**: every 500 ms the loop emits the Tauri event
`huddle-active-speakers` with the pubkeys of peers that sent at least one **non-DTX** frame
in the window, then clears the set. DTX/comfort frames never light a speaker.

**Barge-in / TTS interrupt**: while `tts_active` is true, non-DTX frame arrivals are counted
per peer over a 500 ms window; at `REMOTE_SPEECH_THRESHOLD = 5` frames the `tts_cancel`
flag is set, which silences agent speech within ~15 ms. The counter is reset on the rising
edge of `tts_active`.

### 1.12 Relay-side room

`crates/buzz-relay/src/audio/room.rs`, `handler.rs`.

- `AudioRoomManager` maps `(community_id, channel_id) → Room`. Rooms are in-process; empty
  rooms are evicted (`cleanup_if_empty`), which also clears the pinned protocol version.
- `AudioPeer { pubkey, audio_tx: mpsc::Sender<Bytes>, ctrl_tx: mpsc::Sender<PeerCtrl>, peer_index: u8 }`.
  **Two channels per peer, deliberately:** audio capacity 8 (=160 ms) with `try_send`
  drop-on-full because real-time audio tolerates loss; control capacity 32 which must never
  drop, because `joined`/`left` are state-bearing (they maintain the client's
  `peer_index → pubkey` map).
- `MAX_PEERS_PER_ROOM = 25` soft cap (a room of N generates N×(N−1) frame copies per
  20 ms tick); 255 is the hard cap from the `u8` index space. Indices are recycled through
  a free list.
- `AdmissionGuard` holds one mutex across the `ended` check, index allocation and peer
  insert, so `mark_ended` is mutually exclusive with admission — this closes the race
  between the last peer's cleanup and a concurrent joiner.
- Frame limits: `MAX_AUDIO_FRAME_BYTES = 4096`, `MAX_TEXT_FRAME_BYTES = 8192`, WS parser
  capped at 8 KB.
- Heartbeat 30 s, `MAX_MISSED_PONGS = 3`.
- The relay **never decodes audio**; broadcast is opaque byte forwarding with a 1-byte
  index prefix.
- Multi-pod (`crates/buzz-relay/src/audio/join.rs`, `mesh.rs`): ownership of a huddle is
  arbitrated by a **fenced Redis CAS lease** keyed on the channel id. A pod that holds it
  is the owner; other pods open a `HuddleControl` mesh stream to the owner and register
  their local clients as remote peers (`RegisterPeer`/`UnregisterPeer` →
  `PeerRegistered`/`RegisterRejected`, postcard-encoded). Membership never grants
  ownership. Every registration's fence is re-validated against Redis on receipt.
  On owner lease loss or intentional drain, local clients are closed so they rejoin
  against the fresh generation. When mesh/Redis is not deployed, set
  `BUZZ_HUDDLE_AUDIO_AVAILABLE=false` (default `true`) and joins fail with a handleable
  `huddle_audio_unavailable`, which the client renders as *"Huddle audio isn't available on
  this server. Ask an administrator to turn it on."*
  (`desktop/src/features/huddle/lib/huddleError.ts:formatHuddleActionError`).

### 1.13 STT (transcription) pipeline

`desktop/src-tauri/src/huddle/stt.rs`, `transcription.rs`, `pipeline.rs:spawn_transcription_task`.

```
48 kHz f32 PCM (from push_audio_pcm)
  → bounded sync_channel (AUDIO_QUEUE_DEPTH = 50 ≈ 5 s / ~1 MB)
  → dedicated std::thread (not async — sherpa-onnx is CPU-bound and not Send across awaits)
      rubato Fft resampler 48 kHz → 16 kHz mono
      earshot VAD, exactly 256 samples/frame, threshold 0.5
      accumulate speech; flush after SILENCE_FLUSH_FRAMES = 19 (~300 ms) of silence
      sherpa-onnx NeMo Parakeet TDT-CTC 110M int8 offline recognizer, 1 intra-op thread
  → tokio::mpsc<String>
  → tokio task: build kind:9 message on the EPHEMERAL channel, p-tagged with current agents
```

- `MAX_SPEECH_SAMPLES = 16_000 * 30` (30 s) caps the speech buffer so a noisy room can't OOM.
- Echo/barge-in gating: while `tts_active` the accumulated speech is discarded; a 50 ms
  `TTS_COOLDOWN` after TTS stops prevents transcribing the tail; `BARGE_IN_DEBOUNCE_FRAMES = 20`
  (~320 ms) consecutive VAD-speech frames during TTS sets `tts_cancel` (long enough to reject
  laptop-speaker feedback, short enough to catch real interruption).
- In PTT mode the pipeline only accumulates while `ptt_active`; in VAD mode it runs continuously.
  Switching mode mid-huddle **restarts** the STT pipeline, because the mode is captured at
  construction (`mod.rs:set_voice_input_mode`).
- The posting task reads `agent_pubkeys` from a shared `Arc<Mutex<Vec<String>>>` **at post
  time**, so p-tags reflect mid-huddle agent additions rather than a stale snapshot. It
  checks `session_generation` before every POST and `break`s (not `continue`s) when stale.
- Publish order is `wait_for_rate_limit() → sign event → build NIP-98 auth header → POST
  /events`, so both timestamps are fresh (the relay enforces ±60 s NIP-98 freshness and the
  admission gate can hold for up to 300 s).
- An egress guard (`egress_guard::assert_no_key_backup_bytes`) inspects the serialized body
  before any bytes reach the network.

**Transcription auto-enable rule** (`state.rs:maybe_auto_enable_transcription_for_agents`):
transcription turns itself on the first time an agent is present, *unless the user has
already used the transcript control this session* (`transcription_user_controlled`). It
returns `true` only on the disabled→enabled transition so callers start the pipeline
exactly once. Removing the last agent deliberately does **not** turn it back off.

### 1.14 TTS (agent speech) pipeline

`desktop/src-tauri/src/huddle/tts.rs`, `tts_audio.rs`, `preprocessing.rs`,
`crates/buzz-voice/src/pocket.rs`.

- Engine: Kyutai **Pocket TTS** (April 2026 `english_2026-04` bundle, ONNX INT8 export
  `KevinAHM/pocket-tts-onnx` at a pinned revision), 24 kHz mono output, default reference
  voice = VCTK p333 WAV.
- Worker thread owns one engine and one persistent `rodio::Player`. Per text item:
  preprocess → split into sentences → synthesize each sentence → clamp to full scale +
  fade out → append to the player (gapless).
- **Lookahead pipelines across items, not just sentences**: the worker only blocks on the
  text channel when the player is empty. With sentence-per-message delivery, a per-item
  drain barrier would insert a full synthesis latency of dead air between every sentence.
- `TEXT_QUEUE_DEPTH = 8`; excess items are dropped with a warning.
- A 10 ms **barge-in monitor thread** watches `tts_cancel` and silences the player on the
  rising edge (~15 ms flag-to-silence) even while the worker is blocked inside synthesis.
  Monitor and worker player mutations are serialized through a `player_ops` mutex with the
  flag re-checked under the lock.
- `tts_active` is shared with STT for mic gating.

**How agent text reaches TTS** (`desktop/src/features/huddle/lib/useTtsSubscription.ts`,
`ttsLiveMessages.ts`):

- A **live-only** relay subscription (`limit: 0`, kinds 9 + 40002, `#h` = ephemeral id).
  Dedupe by event id with a 5000-entry LRU for reconnect replay.
- Eligibility (`classifySpeakableAgentText`) rejects, with a named reason each:
  `unsupported_kind`, `h_tag_mismatch`, `author_not_agent`, `self_authored`,
  `empty_or_system` (blank, or starts with `[System]`). Attachment markdown lines whose URL
  appears in an `imeta` tag are stripped before the emptiness check.
- **Fail-closed on membership**: `agentsLoaded` starts `false`; nothing is ever spoken
  until `get_huddle_agent_pubkeys` succeeds. It refreshes every 30 s, and **any** failure —
  including a refresh after prior success — clears the set and mutes TTS. Stale membership
  must never authorize speech.
- `createInitialTtsReadinessGate` buffers arriving events in order until *both* membership
  and `tts_enabled` are known, then releases them; a failure drops the buffer with a reason.
- `createOrderedSpeaker` serializes native `speak_agent_message` calls so queue order equals
  arrival order, and carries a generation so disabling TTS drops everything already queued.
- `createLatestStateGate` ensures a slow `get_huddle_state` bootstrap snapshot cannot
  overwrite a newer live `huddle-state-changed` event.
- Rust side (`mod.rs:speak_agent_message`) truncates by **char count** (not byte length —
  multi-byte UTF-8 would panic), lazily starts the pipeline if models finished downloading
  mid-huddle, and distinguishes three outcomes: disabled → `Ok(())` no-op; no active
  huddle → error; enabled-but-unavailable → error (never a silent drop).

**Voice-mode guidelines** (`huddle/agents.rs:voice_mode_guidelines`) — posted as kind
48106 into the ephemeral channel, telling agents: reply immediately, send **one sentence
per `messages send` call** (the prompt-level equivalent of token streaming, cutting
time-to-first-audio), no markdown/code/lists, say "I'll post that in the main channel" for
code, one short sentence before running a tool, drop unsent sentences if a human speaks
mid-reply, do nothing when not addressed. Agents see it via EOSE replay on subscribe, which
is why it must be published *before* the membership event.

### 1.15 Voice models

`desktop/src-tauri/src/huddle/models.rs`:

- STT: sherpa-onnx `parakeet-tdt_ctc-110m-en` int8 archive downloaded from the
  k2-fsa GitHub release, SHA-256 pinned, `MAX_STT_DOWNLOAD_BYTES = 200 MB`, expected files
  `model.int8.onnx`, `tokens.txt`, plus a written `MODEL_LICENSE.txt` (CC-BY-4.0
  attribution to NVIDIA/k2-fsa) placed beside the bytes.
- TTS: 8 pinned Pocket artifacts from HuggingFace, each with SHA-256 + size,
  `MAX_TTS_FILE_BYTES = 100 MB` each, plus license + reference-voice WAV.
- A `.buzz-model-manifest` file with `STT_MODEL_VERSION` / `TTS_MODEL_VERSION` drives
  re-download on bundle bumps.
- `ModelStatus` is `ready | downloading{progress_percent} | error | pending`;
  `get_model_status` returns `{stt, tts}` and the huddle bar polls it every 10 s while
  connected, rendering e.g. `Voice models: STT 43%, TTS ready`.
- `check_pipeline_hotstart` is invoked by the webview every 15 s while in a huddle: it
  clears handles for pipelines whose worker thread has exited, starts pipelines whose
  models just finished downloading, and (throttled to 15 s) refreshes agent membership.

### 1.16 The huddle bar UI

`desktop/src/app/AppHuddleBar.tsx` is a thin wrapper (profile-panel provider +
`className="h-full"`) around `desktop/src/features/huddle/components/HuddleBar.tsx`. It is
mounted once in `AppShell.tsx` inside `<HuddleProvider>` and is visible only while
`phase ∈ {connected, active}`.

Layout: a 3-column grid `[1fr auto 1fr]` — status/error cluster on the left, the control
cluster centred on the axis, an empty spacer right so the controls stay optically centred.
Exit is a 260 ms slide-out (`HUDDLE_DRAWER_EXIT_MS`), during which the last rendered state
is retained (`renderedState`) so the bar doesn't blank mid-animation.

State: primary source is the Tauri `huddle-state-changed` event; a 30 s poll of
`get_huddle_state` is a slow fallback only. `stateGenerationRef` discards a pending poll
result after a newer event; `locallyLeavingChannelRef` suppresses a late "still active"
state for a channel the user just left.

**Every control, left to right:**

| Control | Component | Behaviour |
|---|---|---|
| Error banner | inline | `huddleError` from context, dismissible ✕ (`clearHuddleError`) |
| Model progress | inline `<output>` | shown while STT (if transcription on) or TTS isn't ready |
| Agent-add error / reaction error / transcript error | inline chips | truncated, non-blocking |
| **Mic split button** | `MicControls` | Left half toggles local mute by setting `localAudioTrack.enabled = !isMuted`. Icon `Mic`/`MicOff`; variant `destructive` when muted or unavailable. In PTT mode the label is *"Force mute (overrides PTT)"*. When the mic is unavailable the button is `aria-disabled` and the tooltip explains permissions. |
| Mic meter / chevron | `MicControls` | Right half of the split opens the audio popover. While unmuted it renders a **3-bar VU meter** driven by `micLevel`; the bars swap to a chevron on hover/focus/open. Respects `prefers-reduced-motion` (bars freeze at idle height). |
| Audio popover | `MicControls` | (a) **Push to Talk** toggle with a `⌃Space`/`Ctrl+Space` kbd hint; (b) **Microphone** device list (`DeviceList`, "System default" + enumerated `audioinput`s, checkmark on the selected one, footnote *"Change takes effect on next huddle"*); (c) **Input Volume** range 0–1 step 0.01 applied live to the worklet `GainNode`, shown as a percentage; (d) a "Microphone unavailable" help block with an **Open Settings** button on macOS (deep-links `x-apple.systempreferences:...Privacy_Microphone`). |
| **Speaker split button** | `SpeakerControls` | Left half toggles **agent TTS** (`set_tts_enabled`), icon `Volume2`/`VolumeX`, destructive when muted. This is the closest thing Buzz has to "deafen" — it silences synthesized agent speech only; **there is no control that mutes other humans.** Right half opens the speaker popover with the output `DeviceList` (names from `list_audio_output_devices`). |
| Headphones hint | `SpeakerControls` | A one-shot popover *"Headphones help prevent echo"* shown because remote audio plays through native rodio, outside the WebView render graph, so the browser's AEC has no far-end reference (`aecMissing = true` in `HuddleBar`, to be flipped in the same change that moves playout into WebAudio). Dismiss with "Got it". |
| **View thread** | `MessageSquareText` button | Disabled until the 48100 event id for this ephemeral channel is found via `subscribeToHuddleEvents` on the parent; then opens that thread. |
| **Participants** | `ParticipantList.tsx:HuddleParticipantsControl` | `UsersRound` icon with a count badge. Popover lists every participant: avatar (or an `HexAvatar` — a 6-char hex prefix on an HSL colour derived from the first 4 hex chars), display name, and a subtitle that is `"Speaking"` when the pubkey is in `activeSpeakers`, else `"Agent"` for agents, else `"In huddle"`. **The speaking indicator is a 2 px green ring on the avatar.** Agents get a remove ✕ that calls `remove_channel_member` and optimistically prunes local state. |
| **Emoji reactions** | `EmojiPicker` in a popover | Publishes kind 24810 to the ephemeral channel and bursts locally at once (optimistic). A live subscription (`kinds:[24810]`, `#h`, `since: now`) bursts everyone else's, skipping your own pubkey. Sender name is clamped to 48 chars; custom emoji carry `["emoji", shortcode, url]`. |
| **Transcript** | `Captions` toggle | `set_huddle_transcription_enabled`, `aria-pressed`. |
| **Add agent** | `Bot` button → `AddAgentDialog` | Lists `list_managed_agents` filtered to `status === "running"` and not already in the huddle; `add_agent_to_huddle` returns `{ephemeral_added, parent_added, parent_error}` and a parent-channel failure is shown as a **warning that keeps the dialog open**, not an error. |
| **Leave** | destructive pill with `PhoneOff` | `leaveHuddle()`; `aria-busy` while in flight; if backend cleanup fails the bar stays up for a retry. |
| Screen-reader status | `<output aria-live="polite">` | announces mic-connected state, voice input mode (with the PTT key), and model download progress. |

`add_agent_to_huddle` (`mod.rs`, `agents.rs`) enforces the 20-agent cap on incremental
adds too, adds to the ephemeral channel (**hard failure**), then preserves an existing
parent-channel membership *regardless of role* or adds the agent to the parent as `bot`
(**best-effort**) — rewriting an existing DM member as `bot` is both unnecessary and
forbidden for non-admins.

### 1.17 Entry points and the huddle card

- `HuddleIndicator.tsx` — a headphone button (or dropdown item) in the channel members bar.
  It subscribes to kinds 48100–48103 (`limit: 100`) and **reconstructs** huddle state from
  the full seen set on every event, sorted by `created_at`, then `kind` (start < join <
  left < end is the causal order), then `id`. This survives out-of-order delivery,
  reconnect replay, and late mounts. Two rules: an `ended` ephemeral channel is remembered
  so a late-arriving relay 48102 cannot resurrect a phantom huddle; and join/left events
  with no preceding 48100 (start pushed out of the 100-event window) *infer* the huddle
  exists, with the participant count floored at 1. It also listens for
  `huddle-state-changed → phase === "idle"` to clear immediately rather than waiting for a
  48103 that may never arrive if the relay connection tears down first.
- `HuddleAttachment.tsx` — the in-timeline card rendered for a 48100 message: headphone
  tile, "Huddle · In progress|Ended", participant count, and a Join or View-thread action.
  It runs the same reconstruction seeded with the message itself.
  **A 48100 older than `HUDDLE_JOINABLE_WINDOW_SECONDS = 3600`** (matching the ephemeral
  channel TTL) is treated as ended even without a 48103
  (`lib/huddleCardState.ts:isHuddleStartStale`).
- `WaveMessageAttachment.tsx` — a 👋 card offering "Start a huddle to talk to them".
- `UserProfilePopover.tsx` — starts a huddle in a DM (passing the bot's pubkey as a member
  when the profile is an agent).
- `ChannelMembersBar.tsx` — the main start path; after starting it invalidates the
  `["channels"]` query so the ephemeral channel appears in the sidebar immediately (the
  default poll is 60 s, far too slow for huddle UX).

### 1.18 Disconnect / reconnect

- The relay pipeline task emits the Tauri event `huddle-audio-disconnected` **only on
  unexpected exits** (`!cancel.is_cancelled()`).
- `HuddleContext.tsx` handles it by keeping the huddle, mic and voice pipelines live and
  reconnecting only the audio WS, with a bounded backoff of
  `[0, 100, 250, 500, 1000, 2000, 2000] ms` — the early retries make remote-owner handoff
  fast; the two 2 s tails cover Kubernetes Service endpoint removal after a draining pod
  flips readiness. An in-flight guard collapses duplicate disconnect events. If every
  attempt fails, it calls `leaveHuddle()`.
- `tokenRef` makes an intentional leave/start supersede a reconnect loop.
- Repeated bounded recovery cycles are intentional while the relay remains connectable.
- On the relay side, an owner lease loss or drain closes local clients so they rejoin
  against a fresh generation; the local fence is "forgotten" so the new generation isn't
  suppressed as stale.

### 1.19 Push-to-talk shortcut

`desktop/src-tauri/src/ptt_shortcut.rs`. `Ctrl+Space` is registered with the OS **only**
while `voice_input_mode == PushToTalk` *and* phase ∈ {Connected, Active}; registration is
re-synced from `emit_huddle_state` on every state change. Reserving it app-wide would
conflict with IDEs. Press/release emit the Tauri event `ptt-state: boolean`.

The webview plays a 50 ms sine cue on PTT transitions (880 Hz on press, 440 Hz on release,
gain 0.05) from a **single persistent `AudioContext`** reused across presses — browsers cap
concurrent AudioContexts at ~6.

### 1.20 Mic level metering

`HuddleContext.tsx` runs an `AnalyserNode` (fftSize 512) at ~30 Hz (`MIC_ANALYSER_UPDATE_INTERVAL_MS = 33`)
with an adaptive noise gate, all constants exported from the file:
`MIC_INITIAL_NOISE_FLOOR = 0.01`, gate on at RMS `0.018`, off at `0.012`, margin `0.012`,
active range `0.11`, minimum displayed active level `0.18`, attack `0.58`, noise-floor rise
while active `0.006`. Below the gate the level is hard `0`, so a silent room shows nothing
rather than shimmering.

### 1.21 What huddles deliberately do **not** have

- **No screen share.** No `getDisplayMedia` call exists anywhere in the repo.
- **No video.** The audio room is mono Opus only.
- **No recording / per-track publishing.** ARCHITECTURE.md notes the kinds are reserved but
  no producer exists.
- **No background blur, and `@mediapipe/tasks-vision` is not used by huddles at all.** Its
  only consumer is the **animated avatar capture** feature
  (`desktop/src/features/profile/lib/animatedAvatarCapture.ts`): a 3 s, 12 fps, 256 px
  camera recording where MediaPipe *selfie segmentation* (`ImageSegmenter`,
  `outputConfidenceMasks: true`, `runningMode: "VIDEO"`) removes the background per frame so
  the person can be composited as a sticker popping out of a coloured backdrop disc, encoded
  as a ping-pong looping APNG via `upng-js`. Notable details: the wasm bundle and the
  `selfie_segmenter.tflite` model are fetched lazily from public CDNs and **failure to load
  degrades to "recording works, background isn't removed"**; the person channel is resolved
  once from `segmenter.getLabels()` because releases vary between `person`/`selfie`/
  `foreground` and a single inverted `background` channel; masks use a soft alpha ramp
  (0.32→0.7) and temporal smoothing; `segmentForVideo` requires strictly increasing
  timestamps.
- **No deafen.** The speaker control mutes agent TTS only.

---

## Part 2 — Media

### 2.1 Protocol: Blossom over S3

Media is **Blossom** (BUD-01/02/11) served by the relay and stored in S3/MinIO.

Endpoints (`crates/buzz-relay/src/router.rs`):

| Method | Path | Handler |
|---|---|---|
| PUT | `/upload` | `api::media::upload_blob` (canonical) |
| PUT | `/media/upload` | same handler, legacy alias (counted in `buzz_media_legacy_upload_route_total`) |
| GET / HEAD | `/media/{sha256}.{ext}` | `api::media::get_blob` / `head_blob` |

Auth is a **kind 24242** Nostr event, base64url-no-pad encoded in
`Authorization: Nostr <b64>` (`crates/buzz-media/src/auth.rs:verify_blossom_auth_event_for_verb`):

1. Schnorr signature verifies.
2. `kind == 24242`.
3. `content` is a non-empty human-readable string (BUD-11).
4. exactly one `t` tag equal to the verb (`upload` | `get`).
5. an `expiration` tag in the future.
6. `created_at` not more than 5 s in the future and not older than `max_age_secs`
   (**600 s for buffered uploads, 3600 s for video uploads**, 600 s for `get`) — this
   bounds the replay window independently of the `expiration` tag.
7. if any `server` tags are present, the **per-request tenant host** (not a process-global
   domain) must appear among them, compared through a shared host-normalisation rule
   (case, trailing dot, default ports, optional scheme/path). Fail closed if the bound host
   is unknown. A relay process serves many tenant hosts; validating against one global host
   would 401 every non-primary tenant.
8. Upload additionally requires an `x` tag equal to the computed SHA-256 of the body.

`t=get` tokens are minted **server-scoped** (a `server` tag, no `x` tag) with a 600 s
lifetime, so one token covers an avatar-grid burst or a whole video's range requests
(`desktop/src-tauri/src/commands/media.rs:sign_blossom_get_auth_header`,
`MEDIA_GET_AUTH_EXPIRY_SECS`). This is broader than per-blob scoping and is only safe
because the relay still enforces NIP-43 membership on the verified pubkey and because the
client only ever attaches the header to its own relay origin. Read auth is gated by
`BUZZ_REQUIRE_MEDIA_GET_AUTH`; the client **fails open** (sends no header when signing is
unavailable, e.g. key recovery) so media keeps rendering when the flag is off.

### 2.2 Storage layout

`crates/buzz-media/src/storage.rs`:

- Blob: `{sha256}.{ext}` — content-addressed, **shared across communities**.
- Sidecar: `_meta/{community_id}/{sha256}.json` — the sidecar key is **community-scoped and
  is the tenant read gate**. Two communities can hold the same bytes; each needs its own
  sidecar, and a blob whose sidecar is absent in your community is not readable by you.
- Thumbnail: `{sha256}.thumb.jpg`.
- Optional per-upload moderation records under `_uploads/`.

`BlobMeta` (sidecar JSON): `dim` (`"WxH"`), `blurhash`, `thumb_url`, `ext`, `mime_type`,
`size`, `uploaded_at`, `duration_secs`.

`BlobDescriptor` (BUD-02 response, `crates/buzz-media/src/types.rs`):
`{ url, sha256, size, type, uploaded, dim?, blurhash?, thumb?, duration? }`.
Descriptor URLs are rewritten to the requesting tenant's host before returning.

### 2.3 Upload pipelines

`crates/buzz-media/src/upload.rs`. The handler sniffs the first 4096 bytes (replaying them
into the chosen pipeline so the stored bytes are byte-identical) and picks one of three
paths.

**Buffered path (`process_buffered_upload`)** — shared by images and generic files:
`spawn_blocking(validate → sha256 → verify Blossom auth)` → key `{sha}.{ext}` →
**idempotency short-circuit only if BOTH sidecar and blob exist** (if the sidecar exists but
the blob doesn't, fall through and re-upload) → `put` blob → build metadata (thumbnail for
images) → optional moderation record → **`put_sidecar` last**, because the sidecar is the
serve gate. On metadata failure the orphan blob is deliberately **not** deleted: concurrent
uploads of the same hash could race and delete a blob another request is about to reference.
Orphans are content-addressed and size-bounded; a future GC sweeps them.

**Video path (`process_video_upload`)** — never buffers in RAM: stream body → temp file
while hashing incrementally (64 KiB reads, 4 KiB sniff buffer) → ISO-BMFF check → Blossom
auth with the computed hash → full MP4 validation on the temp file → `put_file` (8 MiB
streaming read) → sidecar with `duration_secs` (no server thumbnail; the desktop supplies
the poster). Content-Length is fast-failed against the cap before streaming starts, and
axum's body-limit error is detected by three Display-string patterns so it becomes a 413,
not a 500.

**Size limits** (`crates/buzz-media/src/config.rs`, relay env in
`crates/buzz-relay/src/config.rs`):

| Kind | Env | Default |
|---|---|---|
| image | `BUZZ_MAX_IMAGE_BYTES` | 50 MB |
| animated GIF | `BUZZ_MAX_GIF_BYTES` | 10 MB (must be ≤ image cap) |
| video | `BUZZ_MAX_VIDEO_BYTES` | 500 MB |
| generic file | `BUZZ_MAX_FILE_BYTES` | 100 MB |
| concurrent uploads | `BUZZ_MEDIA_MAX_CONCURRENT_UPLOADS` | 8 (per-pubkey 2) |
| uploads/min | `BUZZ_MEDIA_UPLOADS_PER_MINUTE` | 30 |

`MediaConfig::validate()` fails startup on incoherent config: `public_base_url` must end in
`/media` and not `/`; an IP header without upload records enabled is an error (an operator
who set it believes IPs are being recorded); a port header without an IP header is an error.

**Type validation** (`crates/buzz-media/src/validation.rs`):

- Images: magic-byte sniff only (never Content-Type), allowlist
  `image/jpeg | image/png | image/gif | image/webp`, size cap, metadata-free container
  check, then an **image-bomb guard of 25 megapixels** checked via `imagesize` *before* full
  decode — and fail closed if dimensions can't be parsed.
- Video: MP4 only. Brand must not be QuickTime `qt  `; exactly one video track using
  `avc1` (H.264 — HEVC/VP9/AV1 rejected); at most one audio track using `mp4a` (AAC);
  duration ≤ 600 s from `mvhd` timescale (not edit lists); resolution ≤ 3840×2160;
  **`moov` must precede `mdat`** (fast-start), checked by a raw top-level atom scan because
  the `mp4` crate parses regardless of order. Atom scanning is bounded
  (`MAX_ATOMS = 1024`, `MAX_BOXES = 100_000`, depth 32) with a forbidden/allowed box list.
- Generic files: size cap; **any ISO-BMFF container is rejected outright** (arbitrary major
  brands mean `infer` can't enumerate valid MP4 signatures, and an MP4 must never fall
  through as an opaque attachment); any sniffed `image/*`, `video/*` or `audio/*` is
  rejected (audio has no sanitizer yet); a deny-list of active content and executables
  (`text/html`, `application/xhtml+xml`, `image/svg+xml`, `application/javascript`,
  `text/javascript`, `x-msdownload`, `x-executable`, PE, Mach-O, `x-sharedlib`, `x-elf`,
  `x-msi`, `.apk`, `.dmg`); unsniffable files (text, CSV, JSON, source) are accepted as
  `application/octet-stream`.
- `serve_inline(mime)` is `image/* || video/*`. **Everything else, including PDF, is served
  with `Content-Disposition: attachment`** plus `X-Content-Type-Options: nosniff` and
  `CSP: default-src 'none'` — the deny-list is defence in depth on top of those headers.

**Thumbnails** (`crates/buzz-media/src/thumbnail.rs`): images only. `img.thumbnail(320,320)`
preserving aspect, encoded JPEG, plus a **blurhash computed from the thumbnail** (4×3
components) rather than the full image, for speed. Videos get **no server thumbnail** — the
desktop extracts a poster frame instead.

### 2.4 Serving

`crates/buzz-relay/src/api/media.rs:get_blob` supports HTTP **206 range** requests:

- Single range only; a comma-separated multi-range header is ignored (treated as a full GET).
- Absolute `bytes=START-END`, open-ended `bytes=START-`, and suffix `bytes=-N` (RFC 9110
  §14.1.2) are all supported.
- Unsatisfiable (start ≥ total) → **416** with `Content-Range: bytes */TOTAL`.
- Each 206 chunk is capped at **16 MiB**; the client issues more ranges for the rest.
- `Cache-Control` differs depending on whether `require_media_get_auth` is on.

### 2.5 Desktop upload flow

`desktop/src-tauri/src/commands/media.rs` + `media_transcode.rs`; the webview never touches
the filesystem.

Commands:

- `pick_and_upload_media` — native multi-select dialog with **no file-type filter**; each
  path goes through `process_picked_path`.
- `pick_and_upload_image` — same, but rejects non-images *before upload*.
- `upload_media_bytes(data, filename, progress_id)` — for paste/drop from the webview.
- `upload_media(file_path, is_temp)` — only reads files inside the OS temp dir.
- `fetch_media_bytes(url)` — returns raw bytes over IPC for the composer image editor, so
  the canvas gets pixel access via a same-origin `blob:` URL without CORS.

`process_picked_path` is the TOCTOU-safe pipeline: **open the fd first**, then resolve the
fd's real path (`fd_real_path`, per-OS: `F_GETPATH` / `/proc/self/fd` / `GetFinalPathNameByHandleW`)
and verify containment, then sniff 4096 magic bytes **from the pinned fd**, then branch:

- **video** → `transcode_to_mp4` via ffmpeg (always re-encodes; handles HEVC/VP9/ProRes/
  non-faststart/10-bit/MOV) with `-c:v libx264 -preset fast -crf 23 -pix_fmt yuv420p
  -vf pad=ceil(iw/2)*2:ceil(ih/2)*2 -c:a aac -b:a 128k -movflags +faststart`, all metadata
  and chapters stripped (`-map_metadata -1 -map_chapters -1 -sn -dn`, bitexact flags,
  `-metadata encoder=`), `-protocol_whitelist file,pipe`, `-loglevel error`, 600 s timeout.
  The fd is kept alive until ffmpeg finishes so the inode can't be swapped.
  Also extracts a **poster frame**, uploaded separately; the poster's URL becomes the
  descriptor's `image` field. Poster upload failure is non-fatal.
- **HEIC/HEIF** (by brand *or* `.heic`/`.heif` extension) → transcoded to JPEG, because the
  webview can't decode HEIC.
- **otherwise** → read the rest from the open fd.

Then `detect_and_validate_mime` (client-side mirror of the relay deny-list) and
`sanitize_image_for_upload` — decode, apply EXIF orientation, re-encode, which strips all
metadata; animated PNG/WebP are detected (`acTL` chunk / `ANIM`|`ANMF` chunks) and routed
to structural sanitizers so frame timing/looping/disposal survive.

Filenames are sanitized (`sanitize_filename`: keep the final path segment across both
separator styles, drop control chars, cap at 255, fallback `"file"`).

Upload progress is emitted as a Tauri event `media-upload-progress` `{id, sent, total}`,
correlated by the caller-supplied `progress_id`.

If the canonical `/upload` route 404/405s, the client retries the legacy `/media/upload`.

### 2.6 Composer upload UX

`desktop/src/features/messages/lib/useMediaUpload.ts`:

- Three entry points: 📎 (native picker), drag-and-drop, paste. Drop/paste **accept any
  file** — the Rust layer and relay enforce the deny-list and caps.
- **Slot reservation preserves order under concurrency**: `reserveSlots(n)` appends `n`
  `null` slots; each upload fires concurrently and `fillSlot(index, descriptor)` writes into
  its own slot, so attachment order matches selection order regardless of completion order.
  The public `pendingImeta` is the null-filtered view.
- Optimistic previews: for videos, a **poster frame is captured client-side** before upload
  (`captureVideoPosterFrame` — load metadata, seek to 0.1 s, draw to a ≤640 px canvas,
  `toDataURL("image/jpeg", 0.82)`) so the composer shows something immediately, plus `dim`.
- Cancel: a cancelled preview id is remembered so a late-arriving descriptor is discarded
  and its slot nulled.
- Drag-over state uses a **depth counter** for nested `dragenter`/`dragleave`, plus window
  `drop`/`dragend` listeners so a stuck highlight self-heals.
- Image annotation (`ComposerImageEditor`): the edited PNG is uploaded and swapped into the
  same slot; `originalsByUrl` keeps the **earliest** pre-edit descriptor so chained edits
  still revert to the true original. It is in-memory only by design — revert does not
  survive a draft round-trip. Originals are pruned whenever their annotated attachment
  leaves the composer.

### 2.7 Attachments in a message: the data shape

Attachments are **NIP-92 `imeta` tags plus matching markdown lines in the body**. Both are
required: the renderer only draws media for URLs literally present in the content.

`desktop/src/features/messages/lib/imetaMediaMarkdown.ts`:

```
["imeta",
  "url <url>", "m <mime>",
  "x <sha256>"?, "size <bytes>"?, "dim <WxH>"?, "blurhash <hash>"?,
  "thumb <url>"?, "duration <seconds>"?, "image <poster url>"?, "filename <name>"?]
```

Only `url` and `m` are always emitted. `x` and `size` are conditional because legacy and
cross-client entries can lack them and the relay validator rejects literal `"x "` /
`"size 0"`. Parsing: `desktop/src/shared/ui/markdown/parseImeta.ts:parseImetaTags` returns a
`Map<url, ParsedImetaEntry>`.

Body lines (`formatImetaMediaLine`):

- video → `\n![video](url)`
- image → `\n![image](url)`
- generic file → `\n[<label>](url)` with `[`, `]`, `\` backslash-escaped in the label
- spoilered media → wrapped in `||…||`
- **agent/team snapshot PNGs** (`*.agent.png` / `*.team.png`) deliberately use the *file
  link* form despite an `image/png` MIME, so the renderer upgrades them to an
  import/download card instead of drawing them inline.

Edits (kind 40003) carry only new `content`, so the composer seeds `pendingImeta` from the
original event's imeta on edit-load, strips the matching trailing media lines from the
visible body (`stripImetaMediaLines`, which stops at the first non-matching line and
understands block spoilers), restores composer-only display labels from the durable
markdown link (`restoreImetaMediaDisplayLabels`), and re-emits a **full new imeta tag set**
on submit. A known projection ceiling: NIP-92 `alt`, `fallback` and `service` fields are
dropped on edit-load because `BlobDescriptor` doesn't carry them.

`splitOutgoingTags` routes `emoji` (NIP-30) and `mention` tags away from the imeta-only
Tauri argument, whose guard rejects any non-`imeta` prefix — that guard is the injection
defence.

### 2.8 Rendering

- **Images** — `ProgressiveImage.tsx`: renders the `thumb` first, then swaps to the full
  image once loaded and `decode()`d (skipping the thumbnail entirely when it resolves to
  the same URL). Blurhash and `dim` from imeta size the frame before load, so there is no
  reflow.
- **Lightbox** — `desktop/src/shared/ui/markdown/imageLightbox.ts` (pure geometry) plus
  `SimpleImageLightbox.tsx`. It is a FLIP animation from the thumbnail's real
  `getBoundingClientRect` and computed corner radii to a centred box at 80 % of the
  viewport, with enter 260 / exit 170 ms and reduced-motion at 100 ms. Zoom is 1–3× via
  wheel/trackpad (`WHEEL_ZOOM_SPEED 0.002`, max delta 0.2 per event, 120 ms trackpad idle
  detection). It builds a **gallery from all visible `[data-image-lightbox-trigger]`
  elements in the same markdown scope**, skipping hidden spoilers and zero-size elements,
  with arrow navigation (slide 280 ms, 48 px, 4 px blur). It recomputes the return target
  at close time so returning after scroll or a re-render lands on the element's current box.
  Mosaic tiles preserve only the container corners they actually touch.
- **Video** — `MarkdownVideoPlayer.tsx` → `VideoPlayer.tsx` (see §2.9).
  `mediaEntry.ts:isVideoMedia` decides the render path: **the imeta MIME is authoritative
  when present**; only legacy events with no `m` fall back to a `.mp4/.webm/.mov` extension
  check.
- **Files** — `FileCard.tsx`: icon, filename, human-readable size, download action. The
  download goes through the native `download_file` Tauri command, **not** an `<a download>`
  link, because a bare link navigates the webview to the blob URL, escapes to the OS
  browser, and gets bounced by corporate CDN interstitials.
- **Audio** — there is no audio player. Audio MIME types are rejected on the generic-file
  path entirely, so audio is not an attachable type at all today.

### 2.9 The video player

`desktop/src/shared/ui/VideoPlayer.tsx` — two surfaces sharing one component.

**Inline** (in the timeline): a rounded 2xl black surface sized from `aspectRatio` (imeta
`dim`) or the natural ratio, `object-cover` with `max-height: 256`, `preload="metadata"`,
poster from imeta `image` (NIP-71) falling back to `thumb`. A frosted "GlassSurface"
control pill slides (never fades — animating opacity on an ancestor of a `backdrop-filter`
flattens the glass mid-transition and reads as a flicker) with play/pause, current time,
scrubber, duration, playback speed (only when the rendered width ≥ 220 px), and volume.
Playback position is persisted per `reviewKey` (`videoPlayerState.ts`) and restored on
`loadedMetadata`. A `requestAnimationFrame` loop mirrors `currentTime` into state so the
progress bar moves smoothly between the browser's coarse `timeupdate` events; seeks are
throttled. Right-click gives Copy Link and — **only for relay-hosted `/media/` URLs on the
resolved relay origin** (`isRelayDownloadable`, read reactively because the origin resolves
async) — Download.

Playback speeds: `2, 1.75, 1.5, 1.25, 1, 0.75, 0.5, 0.25`.

**Review overlay**: a portal-rendered full-screen dark modal (`max-w-[1520px]`,
`max-h-[980px]`) with a header (title + toggle-comments + close), the video letterboxed into
a wrapper sized to the *picture* (not the letterboxed area) so the radius/glow/controls hug
the frame, a floating control pill, a **quick-reaction tray** (`😂 😍 😮 🙌 👍 👎` + an
emoji picker), and a 380 px comments panel that collapses to width 0. Opening the review
pauses the inline video and hands over the current time; closing hands the review position
back. The heavyweight Tiptap composer is mounted only after **two** animation frames so the
dialog paints first. Escape closes the emoji picker first, then the dialog.

### 2.10 Frame-anchored comments on video — exact data shape

This is Buzz's Frame.io-style review. **There is no new event kind and no dedicated field.**

**Storage shape:** a frame-anchored comment is an *ordinary channel message* (kind 9 /
40002) that is a **thread reply to the video message** (`parentId` = the video message's
event id) whose body begins with a bracketed timecode:

```
[MM:SS] text          e.g.  "[01:23] the logo pops here"
[MM:SS.d] text        e.g.  "[00:07.5] audio clips"
[H:MM:SS(.d)] text
```

Parsing regex (`VideoPlayer.tsx:TIMECODE_RE`):
`/^\s*\[((?:(?:\d{1,2}:)?\d{1,2}:)?\d{2}(?:\.\d{1,3})?)\]\s*/`
→ `parseTimecode` accepts 2 or 3 colon-separated numeric parts (`mm:ss` or `hh:mm:ss`);
anything else yields `seconds: null`, i.e. an ordinary un-anchored comment.

Writing format (`formatCommentTimecode`): `formatTimecode(seconds, {fractionalDigits: 1,
trimZeroFraction: true})` — so one decimal, dropped when zero.

`TimecodedComment = { comment: VideoReviewComment, seconds: number|null, timecode: string|null, text: string }`
where `text` is the body with the timecode prefix removed.

```ts
type VideoReviewComment = {
  id: string;            // event id
  author: string;
  avatarUrl?: string | null;
  body: string;          // raw body INCLUDING the "[MM:SS] " prefix
  createdAt: number;     // unix seconds
  time: string;          // pre-formatted relative time
  parentId?: string | null;  // another comment id ⇒ this is a reply
  reactions?: VideoReviewReaction[];   // {emoji, emojiUrl?, count, reactedByCurrentUser?, users[]}
};
```

**Context assembly** (`desktop/src/features/messages/lib/videoReviewContext.ts`):

- `hasVideoAttachment(message)` — true if the body contains `![video](` **or** any `imeta`
  tag has a part starting `m video/`.
- `buildVideoReviewCommentsByRootId(messages)` walks each message's `parentId` chain
  upward, attaching it to **every** ancestor (so a reply-to-a-reply is a comment of the
  video message too), with a `maxHops` guard against cycles, then sorts by
  `createdAt`, then `id`.
- `buildVideoReviewContextForMessage` returns `undefined` for messages without video, so
  the review launcher only appears where it makes sense. `disabled` is true when the
  message is still pending or no send handler exists.
- `VideoReviewContext` = `{ channelId, channelName, channelType, comments, disabled,
  isSending, onSendComment(content, mentionPubkeys, mediaTags?, parentEventId?),
  onToggleCommentReaction(comment, emoji, remove), profiles, rootEventId, title }`.
- It reaches the player through **React context** (`VideoReviewMarkdownContext`), not
  through the markdown component map, because a new component map means new element types,
  which unmounts and remounts every `<video>` — killing playback and any in-progress
  comment draft on every timeline re-render.

**Authoring UI:**

- The composer footer shows the live timecode chip (accented when it will be stamped) and a
  checkbox **"Comment at current frame"** (`postAtCurrentFrame`, default **on**). When
  replying to a comment the checkbox is replaced by "Replying to <author>" — **replies never
  re-stamp**; they inherit the parent's moment.
- Focusing the composer **pauses the video** (`onFocusCapture` → `pauseForCommentAuthoring`).
- On send: `authoredSeconds = video.currentTime` (bounded to `[0, duration]`), body becomes
  `` `[${formatCommentTimecode(s)}] ${trimmed}` `` when stamping, and an **optimistic
  comment** is inserted immediately (id `optimistic-video-review-<ts>-<rand>`, author
  "You", time "now"). On failure the optimistic row is removed, an error is shown, and the
  error is **rethrown** so the composer restores the draft it cleared on submit.
  Optimistic rows are de-duplicated against confirmed ones **by body string**.
- Quick reactions post the emoji as a comment, always stamped, at the current frame.
- Drafts are keyed `video-review:<rootEventId>`.

**Reading UI:**

- **Timeline markers**: every comment with a non-null `seconds` inside the duration renders
  as a 20 px circular avatar pin on the scrubber at `left: seconds/duration*100%`, with a
  tooltip `"<timecode> · <author>"`; clicking seeks.
- **Comment cards**: the timecode renders as a monospace accent pill button that seeks on
  click; replies nest **one level** under their top-level ancestor (deep chains flatten by
  walking to the top ancestor, with a visited set against cycles), sorted by `createdAt`;
  reaction chips toggle; a "Reply" button targets the composer.
- Sorting (`sortTimecodedComments`): stamped comments first, ordered by seconds then
  `createdAt`; un-stamped comments last, by `createdAt`.
- The comments panel renders read-only when there are comments but no send capability;
  with neither, the panel is dropped entirely and the video owns the dialog.

### 2.11 The localhost media proxy

`desktop/src/shared/lib/mediaUrl.ts` + `desktop/src-tauri/src/media_proxy.rs`.

WKWebView's networking stack bypasses the VPN tunnel, so a direct `<img src>` to the relay
gets 403'd by Cloudflare Access. `rewriteRelayUrl(url)` rewrites
`https://<host>/media/<64hex>(.thumb)?.(jpg|png|gif|webp|mp4|webm|mov)` to
`http://127.0.0.1:<port>/media/<path>` (IPv4 literal on purpose — the Rust proxy binds
`127.0.0.1:0` and some WebViews resolve `localhost` to `::1` first), falling back to a
`buzz-media://localhost/...` custom protocol before the port resolves.

- **Only URLs on the resolved relay origin are rewritten.** External Blossom URLs
  (nostr.build, void.cat) pass through unchanged; proxying them would point at the wrong
  server. Origins are canonicalised via `new URL().origin` because the relay always emits a
  lowercased tenant host while the saved community URL keeps the user's typed casing.
- The port and relay origin are polled from Tauri (100 ms interval, 5 s budget, each invoke
  individually deadline-bounded so a wedged IPC call can't hang the loop) and published
  through a `useSyncExternalStore`-compatible subscription so components re-render when they
  resolve. A monotonic `cacheGeneration` is bumped on workspace switch so an in-flight
  lookup for the old community can never repopulate the caches.
- The proxy forwards `Range` headers (so `<video>` seeking works), mints the Blossom `t=get`
  header server-side (the key never reaches the webview), rejects cross-origin JS fetches by
  Origin (empty Origin is allowed — that's how `<video>` loads), and caps non-range full GETs
  at **20 MiB** with a 413 rather than OOMing.
- Downloads (`desktop/src-tauri/src/commands/media_download.rs`) go through
  `validate_download_url`, which requires the relay origin, a `/media/` path, HTTPS
  (HTTP only for a localhost relay), and rejects private/loopback/link-local addresses —
  this is the authoritative SSRF gate; `isRelayDownloadable` in the UI only mirrors it so a
  Download action that could only error is never offered. `MAX_DOWNLOAD_BYTES = 50 MB`,
  60 s timeout.

---

## Part 3 — Canvases

### 3.1 What a canvas is

A **canvas is one markdown document per channel** — a shared, long-lived "what this channel
is about" narrative. It is **not** a drawing surface, not a block editor, and not a CRDT.
Kind `40100` (`KIND_CANVAS`, `crates/buzz-core/src/kind.rs:482`).

```
{ "kind": 40100, "content": "<full markdown document>", "tags": [["h", "<channel uuid>"]] }
```

Builder: `desktop/src-tauri/src/events.rs:build_set_canvas` and
`crates/buzz-sdk/src/builders.rs:build_set_canvas`. Content is length-checked; the `h` tag
is mandatory (`ingest.rs:requires_h_channel_scope` includes `KIND_CANVAS`).

### 3.2 Storage and read model

- The canvas is stored as an ordinary event in the event log, and there is **also** a
  `channels.canvas TEXT` column in Postgres (`crates/buzz-db/src/channel.rs:get_canvas`/
  `set_canvas`) used for channel projections.
- Reading is `query_relay({kinds:[40100], "#h":[channel_id], limit: 1})` — **the newest
  event wins; there is no merge, no diff, and no revision history beyond the event log
  itself** (`desktop/src-tauri/src/commands/canvas.rs:get_canvas`).
- The read command returns `{content, event_id, updated_at, author}` and **explicitly emits
  `null`s** when no canvas exists, because the TS caller distinguishes "no canvas yet" from
  "canvas exists" via `updated_at`/`author`, and an absent JSON key deserializes as
  `undefined`, not `null`.
- Ingest authorization: `KIND_CANVAS` maps to `Scope::ChannelsWrite`
  (`crates/buzz-relay/src/handlers/ingest.rs:292`).

### 3.3 Editing

`desktop/src/features/channels/ui/ChannelCanvas.tsx` + `hooks.ts:useCanvasQuery` /
`useSetCanvasMutation` (React Query key `["channel-canvas", channelId]`).

Two modes, nothing more:

- **Read**: rendered through the shared `Markdown` component (with channel-name linking).
  The parse is wrapped in `React.useDeferredValue` so opening the canvas commits the
  surrounding chrome immediately and the single large markdown render reconciles after.
  Empty state: *"No canvas set for this channel."*
- **Edit**: a plain monospace `<Textarea>` holding the whole markdown document, with
  Save / Cancel. Save publishes a **full replacement** kind 40100 event and invalidates the
  query. The button reads "Create canvas" when there is none.

Gating: `canEdit && !isArchived`. The canvas lives in the channel management sheet as one of
two views (`"summary" | "canvas"`), with a markdown-preview snippet on the summary card.

### 3.4 Collaboration and conflict rules

**Last write wins, unconditionally.** There is no optimistic-concurrency check, no
`expectedUpdatedAt`, no CRDT, no operational transform, and no lock. Two concurrent editors
will clobber each other; the losing version survives only as an older event in the log.
This is a deliberate simplification consistent with "the canvas is a slow-moving channel
narrative, not a live document".

### 3.5 What agents can do with a canvas

Agents have the same surface as humans, through the CLI rather than a bespoke tool:

- `buzz canvas get --channel <uuid>` → **the raw markdown string, or `null`** — deliberately
  *not* a JSON envelope, unlike every other read command
  (`crates/buzz-cli/src/commands/channels.rs:cmd_get_canvas`, documented as an exception in
  `desktop/src-tauri/src/managed_agents/nest_skill.md`).
- `buzz canvas set --channel <uuid> --content "<markdown>"`, where `--content -` reads from
  stdin (`cmd_set_canvas`).
- Channel templates can seed a canvas at creation time (`canvas_template`); the canvas write
  is **best-effort** and its failure does not fail channel creation, matching the desktop's
  `useApplyTemplate.ts`.

Agents also *read* the canvas implicitly: `crates/buzz-acp/src/pool.rs` injects a
`[Channel Canvas]` section into the agent's system prompt on new channel sessions:

```
[Channel Canvas]
Canvas revision (event ID): <event id>
Last modified: <timestamp>
Fetch current content with: buzz canvas get --channel <uuid>
```

Rules encoded there: the section is **never** attached for a DM (or for a channel whose type
can't be determined); a blank canvas produces no section; the fetched section is held in a
local `pending_canvas` and committed to `SessionState::canvas_sections` **only after session
creation succeeds**, so a failed spawn doesn't poison the next attempt; the cache is cleared
on session invalidation so the next session picks up canvas changes; protocol-v1 agents get
the block prepended to the initial message instead of in `systemPrompt`. The revision id —
not the content — is what is cached, so the agent always fetches current bytes.

---

## Part 4 — Local archive (message archive)

`desktop/src-tauri/src/archive/` + `desktop/src/features/local-archive/`.

### 4.1 What it is

An opt-in, **per-identity, per-relay** SQLite copy of relay events, kept in the Buzz "nest"
directory at `<nest>/archive/archive.db`. Two motivations: durable local history, and — the
real driver — **kind 24200 agent observer frames are relay-ephemeral (never stored), so
local archiving is the only way to retain them at all.**

### 4.2 Schema

`desktop/src-tauri/src/archive/store.rs:SCHEMA`. WAL journaling, `busy_timeout = 5000`
(with a 5 s retry loop around the WAL pragma itself since it can be `SQLITE_BUSY`).

```sql
archived_events(identity_pubkey, relay_url, id, kind, pubkey, created_at, raw_json,
                archived_at,  PRIMARY KEY(identity_pubkey, relay_url, id))

archived_event_scopes(identity_pubkey, relay_url, id, scope_type, scope_value, archived_at,
                PRIMARY KEY(identity_pubkey, relay_url, id, scope_type, scope_value))

save_subscriptions(identity_pubkey, relay_url, scope_type, scope_value,
                kinds /* JSON int array */, created_at,
                PRIMARY KEY(identity_pubkey, relay_url, scope_type, scope_value))

observer_channel_index(identity_pubkey, relay_url, id, channel_id NULLABLE, created_at,
                PRIMARY KEY(identity_pubkey, relay_url, id))
  INDEX (identity_pubkey, relay_url, channel_id, created_at DESC, id DESC)

archive_migrations(name PRIMARY KEY, applied_at)
```

An event row is many-to-many with scopes; the raw event is GC'd when its last scope row is
deleted.

**Row payloads are not uniform**: kind 44200 rows store the *decrypted metric payload JSON*,
every other kind stores full Nostr event JSON. Any reader doing `Event::from_json` on an
unfiltered read must filter by kind first.

### 4.3 Scopes and the access-proof model

`ScopeType` = `channel_h | owner_p | referenced_e`. Two proof paths, chosen by kind:

- **Persistent scopes** (`channel_h`, `referenced_e`, and `owner_p` + kind 44200): the relay
  is the source of truth. Candidates are grouped by scope and re-queried via a batched
  authenticated `/query`; **only events the relay returns are inserted**. Kind 44200 content
  is decrypted at ingest and stored as plaintext JSON, fail-closed (decrypt error → drop).
- **Ephemeral scope** (`owner_p`, kind 24200 observer frames): the relay never stores these,
  so `/query` can't verify them. The relay's REQ-time `#p == authed reader` gate *is* the
  access control, and the client additionally applies six fail-closed local checks
  (`archive/mod.rs:validate_ephemeral_frame`): kind is 24200; `#p` contains the current
  identity; an `agent` tag exists; `frame == "telemetry"` (control frames are never
  archived); **the event author equals the `agent` tag value**; and a matching `owner_p`
  save-subscription exists whose `kinds` list includes 24200.

Subscription creation runs a per-scope **access probe** first
(`archive/mod.rs:create_save_subscription`): `channel_h` verifies the identity is in the
channel's kind 39002 member list *or* is the event author, falling back to "can I read kind
39000 metadata" for open channels; `referenced_e` verifies the event is currently readable;
`owner_p` is restricted to the caller's own pubkey in v1. Kinds outside `0..=65535` are
rejected because the nostr crate silently truncates via `as u16`, producing unmatchable
filters.

### 4.4 Write path

`archive_events(candidates)` is three explicit phases so no SQLite connection or lock is
ever held across an await:

1. **plan** on the blocking pool (`pipeline.rs:plan_archive`) → buckets + ephemeral set +
   pre-dropped;
2. **query** the relay per bucket (async, `query_buckets`);
3. **commit** on the blocking pool (`commit_archive`), each phase opening and dropping its
   own `rusqlite::Connection`.

Returns `{persisted, dropped}` — a dropped event is an access denial or invalid payload,
**not an error**.

The live feeder is `desktop/src/features/local-archive/archiveSyncManager.ts`:
one live relay subscription per saved config (`limit: 0` + `#h`/`#p`/`#e` by scope type),
events buffered and flushed to `archive_events` at **25 candidates or 2 s idle**, plus a
final flush on destroy. Resubscription is **single-flight with a pending flag**: a change
arriving mid-pass sets `reloadPending` and the loop runs exactly one more full pass, which
makes concurrent list/subscribe interleavings structurally impossible rather than
guarded per-boundary. The subscription key encodes scope **and sorted kinds**, so a kinds
change tears down and recreates the subscription rather than silently keeping the old
filter. A failed `subscribeLive` is *not* recorded as active, so the next pass retries.
`useArchiveSync(ready)` gates start on observer reconciliation completing — kind 24200 is
ephemeral, so frames emitted before the listener opens are lost forever.

### 4.5 Kind selection and toggles

`desktop/src/features/local-archive/ui/localArchiveKinds.ts` — a grouped checklist
(**Messages & posts**, **Reactions, edits & deletions**, **Huddle events** [48100/48101/
48102/48103], **System messages**) with group tri-state helpers, plus a free-text
**custom kinds** field parsed by `parseCustomKinds` (split on whitespace/commas, accept
`0..=65535` integers only, silently ignore kinds already in the checklist, dedupe, return
invalid tokens for inline feedback). Every kind value derives from a named constant in
`kinds.ts` — never a raw literal.

Toggles for the two `owner_p` feeds (observer frames 24200, agent turn metrics 44200) go
through **atomic Tauri commands** `merge_save_subscription_kinds(kind)` and
`remove_save_subscription_kind(kind)` rather than read-modify-write in TypeScript, because
two concurrent seed hooks would otherwise each read an empty row and the last writer would
clobber the first. Removal deletes the whole row when the kinds list becomes empty; both use
`BEGIN IMMEDIATE`.

### 4.6 Read path / export

- `list_save_subscriptions`, `delete_save_subscription` (which deliberately does **not**
  purge already-archived data — retention is decoupled in v1).
- `read_archived_events(scope_type, scope_value, kinds?, before_created_at?, before_id?, limit?)`
  — newest-first, default page 50, with a **compound cursor** `(created_at, id)` whose
  predicate mirrors `ORDER BY created_at DESC, id DESC` so same-second siblings are never
  skipped at a page boundary. A short page means exhausted. `kinds: []` means "nothing
  matched", not "all kinds" — callers wanting everything pass `null`.
- `read_archived_observer_events_for_channel(channel_id, …)` — same pagination, driven by
  `observer_channel_index`.
- `index_observer_channel_id(entries)` / `read_unindexed_observer_rows()` — a one-shot
  idempotent backfill: TypeScript reads unindexed rows, decrypts each to find its
  `channelId`, and writes back `(id, channelId|null, created_at)` triples. **Rows whose
  decryption yields no channelId still get a row with `channel_id = NULL`**, so they are
  marked processed (a re-run is a no-op) but excluded from every scoped channel view.

There is **no bulk export/import format** and no import path at all — the archive is a local
read cache, not a portable backup. The only "export" surfaces are the paginated read
commands.

### 4.7 What the UI exposes

`LocalArchiveSettingsCard.tsx` in Settings: a per-channel archive builder (channel picker →
kind checklist + custom kinds → create), a list of existing subscriptions with a
human-readable scope label (channel name, "My agent session frames", "My agents' turn
metrics") and a kind summary (`"9, 7, 5, 40002"` or `"9, 7, 5 +3 more"`), a delete action,
plus two switches: **Archive my agents' observer frames** and **Archive my agents' turn
metrics**. A deployment policy can force the observer toggle permanently on ("Always on for
internal builds"), in which case the switch is disabled.

---

## Part 5 — Identity archive (NIP-IA)

Completely unrelated to the local message archive despite the shared word. Spec:
`docs/nips/NIP-IA.md`. Client: `desktop/src/features/identity-archive/hooks.ts`,
`desktop/src/shared/api/tauriIdentityArchive.ts`,
`desktop/src-tauri/src/commands/identity_archive.rs`.

### 5.1 What it is

A **relay-scoped** statement that a pubkey is retired *here*: hide it from active-member and
autocomplete surfaces, keep all its history, imply nothing globally. It fills the gap
between NIP-09 deletion (destroys history, needs the lost key), NIP-51 mute lists (personal,
not authoritative) and NIP-43 membership removal (access control, not UI visibility).

### 5.2 Kinds

| Kind | Name | Signer | Storage |
|---|---|---|---|
| `9035` | Archive Request | user/agent | policy-defined |
| `9036` | Unarchive Request | user/agent | policy-defined |
| `8002` | Archived Identity (delta) | relay | regular |
| `8003` | Unarchived Identity (delta) | relay | regular |
| `13535` | Archived Identities List (snapshot) | relay | replaceable |

A `kind:9035` carries exactly one `p` tag (the target) and exactly one NIP-70 `-` tag;
optional `reason` (`rotated`, `retired`, `bot-rebuilt`, `left-organization`, `spam` —
unknown values MUST be ignored), `replaced-by` (valid 64-hex, must differ from the target),
and `auth` (a NIP-OA owner-attestation tag). `content` is free-form human text and
**clients MUST NOT parse authorization semantics from it**.

The **latest valid `kind:13535` signed by the relay identity from NIP-11 `self` is current
state**. A relay without a stable `self` pubkey MUST NOT publish NIP-IA relay-signed state,
because clients would have nothing to verify against.

Consent paths the relay attests: `self`, `owner`, `admin`, `relay`.

### 5.3 Client surface

- `list_archived_identities()` → `{archived: string[]}` (lowercase hex), cached 30 s
  (`useArchivedIdentitiesQuery`).
- `resolve_oa_owner(targetPubkey)` → `{owner, isMe} | null` — resolves the target's NIP-OA
  owner from its live `kind:0` `auth` tag; `null` when there's no kind:0, no `auth` tag, or
  verification fails. Gates the owner-path Archive button.
- `archive_identity(req)` / `unarchive_identity(req)` — `{targetPubkey, content?, reason?,
  replacedBy?}`. The desktop attaches the owner's `auth` tag automatically when the caller
  is the verified owner-of-agent.
- `useIdentityArchive(pubkey)` composes the gates: `canArchive = isSelf || relay
  owner/admin || verified OA owner of the target`. **The client gate is UX only — the relay
  re-verifies authority on submit.**
- `useIsIdentityArchived` returns `undefined` while loading so the "Archived" flair is
  deferred rather than flickering.

### 5.4 The anti-shadowban rule

`useIsArchivedPredicate()` hides archived identities from forward-looking discovery
surfaces (autocomplete, DM picker, member-adder, search, panel-fold), and:

- it **fails open** — returns `false` while the snapshot loads, so a cold start can't
  briefly hide everyone; and
- it is **self-exempt by construction** — the current user is never folded from their own
  client even when archived on the relay. NIP-IA makes archival deliberately non-silent: the
  archived user must be able to see they're archived and self-unarchive. Folding self would
  build exactly the shadowban the NIP exists to prevent. The exemption lives in the
  predicate so no caller can forget it.

---

## Non-obvious rules worth preserving

**Huddles**

1. **Two generation counters, not one.** `huddle_generation` (per start/join attempt) and
   `session_generation` (per teardown / STT restart) answer different questions. Collapsing
   them lets a stale transcript post into a fresh huddle, or lets a superseded start tear
   down its own replacement.
2. **Cancel the audio token before dropping the PCM sender**, or an intentional teardown
   emits a spurious `huddle-audio-disconnected` and triggers a reconnect storm.
3. **`count_human_members` failure defaults to 2, not 1.** Defaulting to "I'm the last one"
   ends everyone's huddle on a transient REST error.
4. **Post the kind 48106 guidelines before the kind 9000 membership events.** Agents
   auto-subscribe on the membership notification and can finish EOSE before a
   later-published guidelines event exists.
5. **48101/48102 are relay-signed**; the participant is in the `p` tag, never `event.pubkey`.
6. **Huddle state is reconstructed from the full event set on every event**, sorted by
   `(created_at, kind, id)` — kind order encodes causality. Ended channels are remembered so
   a late 48102 can't resurrect a phantom huddle, and join/left without a start still infer
   one (with the count floored at 1) because the start may have fallen out of the window.
7. **A 48100 older than the 3600 s ephemeral TTL is treated as ended** even with no 48103.
8. **One NetEq + one rodio Player per peer.** A shared FIFO Player turns 3 simultaneous
   speakers into one voice flipping speakers every 20 ms with unbounded queue growth.
9. **Idle-peer grace (500 ms) and the 4-frame queue high-water** exist because NetEq emits a
   frame on every call and the tokio producer clock is not the device consumer clock.
10. **The audio room is pinned to the first joiner's protocol version.** Admitting a v1
    client into a v2 room silently corrupts every v2 peer's decode.
11. **`level_dbov` is untrusted telemetry**: clamp it, never drop the frame for it, never let
    it influence admission or moderation.
12. **DTX frames must not light the speaking indicator** and must not count toward
    barge-in — a comfort packet means the peer is *silent*.
13. **Barge-in needs ~320 ms of debounce**, not 80 ms; laptop speakers feed TTS back into the
    mic and 80 ms triggered a false interrupt inside the first word.
14. **TTS is fail-closed on membership.** Any failure of the agent-pubkey fetch — including a
    refresh after prior success — must mute TTS. Stale membership must never authorize speech.
15. **PTT events are only forwarded to the worklet in PTT mode**, so Ctrl+Space in VAD mode
    can't accidentally mute you. And the OS shortcut is only reserved while a PTT huddle is
    live, because reserving it app-wide conflicts with IDEs.
16. **One persistent AudioContext for the PTT cue** — browsers cap concurrent contexts at ~6.
17. **The mic level has a hard gate to zero.** A "silent room shimmering at 3 %" reads as a
    bug.
18. **Device changes take effect on the next huddle**, and the UI says so rather than
    pretending otherwise.
19. **Transcription auto-enables once when the first agent appears, and an explicit user
    choice is never undone** by a later membership refresh; removing the last agent does not
    turn it back off.
20. **`push_audio_pcm` is fire-and-forget with a 100 KB cap.** Awaiting it would apply
    backpressure to the audio thread; an uncapped raw IPC body is an allocation DoS.
21. **The relay corroborates an ephemeral channel's claimed parent against a creator-signed
    48100 link event** rather than trusting the parent id sent during audio auth.
22. **Membership never grants huddle ownership** in a mesh deployment; Redis's fenced lease
    is the only arbiter, and the fence is re-validated at every hop.

**Media**

23. **Sniff magic bytes; never trust Content-Type**, on both the client and the relay.
24. **The sidecar is the tenant read gate and is written last.** Blobs are content-addressed
    and shared across communities; the community-scoped sidecar is what makes a blob
    readable. Short-circuit idempotency only when *both* blob and sidecar exist.
25. **Never delete an orphan blob on metadata failure** — a concurrent upload of the same
    hash could be about to reference it. Orphans are bounded; GC them out-of-band.
26. **Check pixel dimensions before decoding** (25 MP cap) and fail closed when dimensions
    can't be parsed.
27. **Any ISO-BMFF container is rejected from the generic-file path** — brands are arbitrary,
    so `infer` can't enumerate valid MP4s and an unfamiliar brand must not become an opaque
    attachment.
28. **Blurhash is computed from the thumbnail, not the full image.**
29. **Video Blossom auth gets a 3600 s window, buffered uploads 600 s** — large uploads on
    slow links need the headroom, small ones don't get it.
30. **Open the fd first, then resolve the fd's real path, then sniff** — and keep the fd
    alive across the whole ffmpeg run. Path-based reads after a file dialog are a TOCTOU.
31. **Always re-encode video client-side.** It normalizes HEVC/VP9/ProRes/10-bit/non-faststart
    into something the relay's validator accepts, and `-map_metadata -1` strips location and
    device metadata.
32. **Only rewrite relay-origin media URLs through the local proxy**; external Blossom URLs
    must pass through untouched, and origins must be compared canonicalised (`URL.origin`)
    because host casing differs between the relay's output and the user's typed URL.
33. **A monotonic cache generation guards the proxy port/origin caches** so an in-flight
    lookup from the previous workspace can't repopulate them after a switch.
34. **`<a download>` is not an acceptable download path in a webview** — it escapes to the OS
    browser. Downloads go through a native command behind an SSRF gate.
35. **Slot reservation, not append**, is what preserves attachment order under concurrent
    uploads.
36. **Attachments need both an imeta tag and a body markdown line.** The renderer keys on
    URLs literally present in the content; an edit that carries only new content would
    otherwise silently drop every attachment.
37. **The imeta MIME is authoritative for the render path**; the URL extension is a legacy
    fallback only.
38. **Snapshot PNGs use the file-link form despite an image MIME**, so they render as an
    import card rather than an inline picture.
39. **The video review context must arrive through React context, not the markdown component
    map** — a new component map remounts every `<video>` and kills playback and drafts on
    every timeline re-render.
40. **Slide the video control pill; never fade it.** Animating opacity on an ancestor of a
    `backdrop-filter` flattens the glass mid-transition.
41. **Frame-anchored comments are ordinary thread replies with a `[MM:SS.d] ` body prefix** —
    no new kind, no new field, so they federate, search, edit, react and thread for free.
    Replies inherit their parent's moment and are never re-stamped. Optimistic rows dedupe by
    body against confirmed ones. A failed post rethrows so the composer restores its draft.
42. **Focusing the review composer pauses the video** — you are commenting *on this frame*.

**Canvases**

43. **A canvas is one markdown document, replaced wholesale, last-write-wins.** No CRDT, no
    concurrency check. Accept that and keep it small.
44. **`get_canvas` must emit explicit `null`s** for `event_id`/`updated_at`/`author`, because
    the caller distinguishes "no canvas" from "canvas exists" and an absent key deserializes
    as `undefined`.
45. **Agents get the canvas *revision id*, not its content**, in the system prompt, with a
    fetch command — cached per session, cleared on invalidation, committed only after the
    session actually starts, and never attached for a DM or an unknown channel type.
46. **`canvas get` returns a raw string / `null`, not a JSON envelope** — an intentional
    exception to the CLI's contract, and documented as one.

**Archives**

47. **Ephemeral kinds can only be archived locally**, and only under fail-closed local
    validation (author == agent tag, `frame == telemetry`, `#p` == me, and a subscription
    that actually lists that kind). There is no relay to ask.
48. **Never hold a SQLite connection or transaction across an await.** Plan → query → commit,
    each phase opening its own connection on the blocking pool.
49. **Kind toggles are atomic server-side commands, not read-modify-write in the client**, or
    two concurrent seed hooks clobber each other's kinds.
50. **Pagination uses a compound `(created_at, id)` cursor** matching the sort order, or
    same-second siblings vanish at page boundaries.
51. **An observer frame that failed to decrypt still gets an index row with `channel_id =
    NULL`** — processed, hidden, and never re-decrypted.
52. **`kinds: []` means "nothing matched", not "everything".**
53. **Deleting a save subscription does not purge archived data.**
54. **The archive sync manager is single-flight with a pending flag** — this is what makes
    concurrent list/subscribe interleavings impossible without per-boundary guards.
55. **Archive sync must not start before observer reconciliation finishes**, or ephemeral
    frames emitted in the gap are lost permanently.
56. **NIP-IA archival must be visible to the archived user.** The hide-predicate is
    self-exempt by construction and fails open while loading; otherwise you have built a
    shadowban.
57. **NIP-IA state is relay-scoped and must never be treated as a global blocklist**, and
    the client gate is UX only — the relay re-verifies.

---

## Infrastructure required to rebuild this

**Runs client-side / peer-to-peer: nothing is peer-to-peer.** Every byte of audio and media
transits the relay. The only genuinely client-local pieces are: the microphone capture graph
(WebAudio + AudioWorklet), Opus encode/decode and NetEq jitter buffering (Rust, in-process),
audio output via cpal/rodio, on-device STT (sherpa-onnx Parakeet) and TTS (Pocket/ONNX), the
localhost media proxy, ffmpeg transcoding, the SQLite archive, and MediaPipe selfie
segmentation for avatars.

**Server infrastructure**

| Component | Required for | Notes |
|---|---|---|
| **Relay** (Rust/Axum, `crates/buzz-relay`) | everything | WS Nostr endpoint + HTTP `/events`, `/query`, `/count`, Blossom `/upload` + `/media/{sha}.{ext}`, and `wss://…/huddle/{channel_id}/audio`. Single process, `Arc<Semaphore>` connection cap, 1024 concurrent handlers. |
| **PostgreSQL** | events, channels, membership, `channels.canvas` | The relay's only durable store for events. |
| **S3 or MinIO** | all media blobs, thumbnails, sidecars, upload records | `BUZZ_S3_ENDPOINT/ACCESS_KEY/SECRET_KEY/BUCKET/REGION`, `BUZZ_S3_ADDRESSING_STYLE=path|virtual` (path for MinIO, virtual for e.g. Railway buckets). `BUZZ_MEDIA_BASE_URL` must end in `/media`. |
| **Redis** | *only* multi-pod huddle audio | Holds the fenced CAS ownership lease per huddle session. Not needed for a single-pod deployment. |
| **Relay mesh transport** (`buzz-relay-mesh`) | *only* multi-pod huddle audio | Carries the `HuddleControl` streams and media datagrams between pods. With N=1, set `BUZZ_HUDDLE_AUDIO_AVAILABLE=true` (the default) and neither is used. With N>1 and no mesh, set it to `false` so joins fail with a handleable `huddle_audio_unavailable` instead of two peers silently never hearing each other. |
| **No SFU, no TURN, no STUN, no ICE** | — | The relay *is* the mixer-less forwarder. There is no NAT traversal problem because clients only ever make an outbound WSS connection. |
| **CDN / reverse proxy (optional)** | media + Cloudflare Access deployments | If media is behind an authenticating edge, the desktop's localhost proxy is mandatory (WKWebView bypasses the VPN tunnel). |

**Client-side prerequisites**

| Dependency | Used for | Failure mode |
|---|---|---|
| **ffmpeg** on `PATH` | video upload transcode, poster extraction, HEIC→JPEG | Hard requirement for video uploads; the error message names the install command per OS. |
| **~250–400 MB of voice models** downloaded on demand | STT (Parakeet TDT-CTC 110M int8, from k2-fsa GitHub releases) and TTS (Pocket April 2026 INT8 bundle, from HuggingFace) | Both SHA-256-pinned. Absent → the huddle still works, voice-only: no transcript, no agent speech. Hot-start picks them up mid-huddle. |
| **cpal/rodio-compatible audio output** | playout | Falls back to the system default when the preferred device isn't found. |
| **Microphone permission** | any huddle | Surfaced as an "unavailable" state with a macOS deep link to System Settings. |
| **Public CDNs** (jsdelivr wasm + storage.googleapis.com tflite) | animated avatar background removal only | Optional: recording still works without background removal. Nothing else in the app fetches assets from a CDN. |
| **Tauri v2 runtime** | raw-binary IPC, global shortcut, native dialogs, custom `buzz-media://` protocol | The audio path depends on `__TAURI_INTERNALS__.invoke` for zero-copy PCM. |

**Environment variables worth carrying over**

```
BUZZ_HUDDLE_AUDIO_AVAILABLE      default true; false on multi-pod without mesh
BUZZ_S3_ENDPOINT / _ACCESS_KEY / _SECRET_KEY / _BUCKET / _REGION
BUZZ_S3_ADDRESSING_STYLE         path | virtual
BUZZ_MEDIA_BASE_URL              must end in /media, must not end in /
BUZZ_MAX_IMAGE_BYTES             50 MB
BUZZ_MAX_GIF_BYTES               10 MB (<= image)
BUZZ_MAX_VIDEO_BYTES             500 MB
BUZZ_MAX_FILE_BYTES              100 MB
BUZZ_MEDIA_MAX_CONCURRENT_UPLOADS         8
BUZZ_MEDIA_MAX_CONCURRENT_UPLOADS_PER_PUBKEY  2
BUZZ_MEDIA_UPLOADS_PER_MINUTE    30
BUZZ_REQUIRE_MEDIA_GET_AUTH      gate Blossom t=get on reads
BUZZ_MEDIA_UPLOAD_RECORDS        per-upload moderation side channel
BUZZ_MEDIA_UPLOAD_IP_HEADER / _PORT_HEADER   trusted edge headers; startup fails if incoherent
```
