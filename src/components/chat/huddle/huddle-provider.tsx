"use client";

// The huddle session: one browser's phase machine, wired to the log and to
// whatever transport is in force.
//
// Every rule lives in `src/lib/buzz/huddle.ts` and is tested there. This file
// is the plumbing between three things that move at different speeds and must
// not be allowed to disagree:
//
//   • **the log** — who is in the call, pushed by Convex, authoritative;
//   • **the session** — what phase *this* browser is in, which only this file
//     changes, and only through `nextHuddleSession`;
//   • **the transport** — the audio path, which may not exist at all.
//
// The load-bearing habit here is that every asynchronous step re-checks the
// generation it started under (`ownsHuddleLifetime`) before it commits. A
// connect is four awaits long and a person can hang up in the middle of any of
// them; without the check, a slow first attempt's success lands on top of a
// second attempt's state, or its failure tears down a call that is already up.
// Buzz calls this `is_current_huddle` and it is the reason the counter exists.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { useToast } from "@/components/toast";
import { useAblyStream, type AblyStatus, type ChannelSignal } from "@/lib/use-ably-channel";
import type { ChatScope } from "@/lib/buzz/channel-types";
import {
  HUDDLE_JOINED_PHASES,
  IDLE_HUDDLE_SESSION,
  appendCaption,
  huddleById,
  isTransmitting,
  liveHuddle,
  nextHuddleSession,
  shouldAutoEnableTranscription,
  type HuddleAction,
  type HuddleCaption,
  type HuddleReaction,
  type HuddleSession,
  type HuddleSnapshot,
  type VoiceInputMode,
} from "@/lib/buzz/huddle";
import {
  HuddleTransportUnavailable,
  transportCanCarryAudio,
  useHuddleTransport,
  type HuddleRoom,
  type HuddleTransport,
} from "./transport";
import {
  addHuddleAgentRef,
  endHuddleRef,
  huddleCaptionRef,
  huddlesForChannelRef,
  joinHuddleRef,
  leaveHuddleRef,
  reactInHuddleRef,
  roomTokenRef,
  scopeArgs,
  startHuddleRef,
  type HuddleView,
} from "./refs";

/** One participant, as the bar draws them. */
export type HuddleRosterEntry = {
  pubkey: string;
  name: string;
  isAgent: boolean;
  speaking: boolean;
  isSelf: boolean;
};

export type HuddleContextValue = {
  scope: ChatScope | null;
  channelId: string | null;
  session: HuddleSession;
  transport: HuddleTransport;
  /** The audio path is up. False with no provider, and everything else works. */
  mediaLive: boolean;
  /** Why there is no audio, shown verbatim. Null when there is. */
  mediaNotice: string | null;
  /** Every huddle this room has a record of, newest first — live or over. */
  huddles: HuddleSnapshot[];
  /** The live huddle in this room, whether or not you are in it. */
  live: HuddleSnapshot | null;
  /** The huddle *you* are in. */
  mine: HuddleSnapshot | null;
  roster: HuddleRosterEntry[];
  localLevel: number;
  captions: HuddleCaption[];
  reactions: HuddleReaction[];
  /** `"live"` when reactions and captions are flowing; `"unavailable"` without Ably. */
  signalTransport: AblyStatus;
  error: string | null;
  busy: boolean;
  transmitting: boolean;
  start: (agentIds?: string[]) => Promise<void>;
  join: (huddleId: string) => Promise<void>;
  leave: () => Promise<void>;
  endForEveryone: () => Promise<void>;
  addAgent: (agentId: string, name: string) => Promise<void>;
  react: (emoji: string) => Promise<void>;
  sendCaption: (text: string) => Promise<void>;
  dispatch: (action: HuddleAction) => void;
  dismissError: () => void;
};

const HuddleContext = createContext<HuddleContextValue | null>(null);

/**
 * The session, from anywhere inside the provider.
 *
 * Throws rather than returning null, because every consumer in this folder is
 * inside the provider by construction and a silent null would turn a wiring
 * mistake into a bar that renders as if no call were happening.
 */
export function useHuddle(): HuddleContextValue {
  const value = useContext(HuddleContext);
  if (!value) throw new Error("useHuddle must be used inside <HuddleProvider>");
  return value;
}

/** Present only when a provider is mounted — for surfaces outside a room. */
export function useHuddleOrNull(): HuddleContextValue | null {
  return useContext(HuddleContext);
}

function sessionReducer(session: HuddleSession, action: HuddleAction): HuddleSession {
  const step = nextHuddleSession(session, action);
  // A refused transition leaves the session untouched. The reducer swallows it
  // because a refusal is a *value* (`turn.ts`'s choice, for the same reason):
  // the callers below inspect the transition themselves when they need to
  // distinguish a benign double-click from a real failure, and a throw here
  // would take a React render down for a second press of Join.
  return step.ok ? step.session : session;
}

/** How many reaction bursts stay on screen. A burst, not a feed. */
const MAX_VISIBLE_REACTIONS = 12;
/** How long one burst lives. */
const REACTION_TTL_MS = 4000;

export function HuddleProvider({
  scope,
  channelId,
  selfPubkey,
  selfName,
  children,
}: {
  scope: ChatScope | null;
  channelId: string | null;
  /** Yours. Null before the Chat key bootstrap has run — no call is possible. */
  selfPubkey: string | null;
  selfName: string;
  children: ReactNode;
}) {
  const transport = useHuddleTransport();
  const { toast } = useToast();
  const [session, dispatch] = useReducer(sessionReducer, IDLE_HUDDLE_SESSION);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mediaLive, setMediaLive] = useState(false);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [speaking, setSpeaking] = useState<readonly string[]>([]);
  const [localLevel, setLocalLevel] = useState(0);
  const [captions, setCaptions] = useState<HuddleCaption[]>([]);
  const [reactions, setReactions] = useState<HuddleReaction[]>([]);

  const room = useRef<HuddleRoom | null>(null);
  // The session as of this render, for callbacks that must not re-create
  // themselves on every phase change — the same trick `use-typing.ts` uses so
  // an Ably stream is not torn down whenever a parent re-renders.
  const current = useRef(session);
  current.current = session;

  /**
   * Change the session, and make the change visible to callbacks **now**.
   *
   * `dispatch` alone is not enough, and the reason is the whole point of the
   * generation counters. A connect is: dispatch `start`, then await a mutation.
   * React has not re-rendered by the time the await resumes, so a guard reading
   * the rendered session would still see the *previous* generation and refuse
   * its own result — the connect would silently never complete. Writing the ref
   * first makes it lead the render rather than lag it, and both end up at the
   * same value because both run the same pure reducer from the same base.
   *
   * Returns the transition so a caller can tell a benign refusal (a second
   * press of Start) from a real one.
   */
  const apply = useCallback((action: HuddleAction) => {
    const step = nextHuddleSession(current.current, action);
    if (step.ok) current.current = step.session;
    dispatch(action);
    return step;
  }, []);

  const startHuddle = useMutation(startHuddleRef);
  const joinHuddle = useMutation(joinHuddleRef);
  const leaveHuddle = useMutation(leaveHuddleRef);
  const endHuddle = useMutation(endHuddleRef);
  const addHuddleAgent = useMutation(addHuddleAgentRef);
  const reactInHuddle = useMutation(reactInHuddleRef);
  const sendCaptionAction = useAction(huddleCaptionRef);
  const issueToken = useAction(roomTokenRef);

  const view = useQuery(
    huddlesForChannelRef,
    scope && channelId ? { ...scopeArgs(scope), channelId } : "skip",
  ) as HuddleView | undefined | null;

  const huddles = useMemo(() => view?.huddles ?? [], [view]);
  const live = useMemo(() => liveHuddle(huddles), [huddles]);
  const mine = useMemo(
    () => (session.huddleId ? huddleById(huddles, session.huddleId) : null),
    [huddles, session.huddleId],
  );

  // ── the roster ─────────────────────────────────────────────────────────
  //
  // Built from the **log**, never from the transport's peer list. A transport
  // peer list is what the audio path believes; the log is what happened. With
  // no provider the two would disagree completely (one is empty), and the one
  // that must win is the one that is true.
  const roster = useMemo<HuddleRosterEntry[]>(() => {
    const snapshot = mine ?? live;
    if (!snapshot) return [];
    const speakingSet = new Set(speaking);
    const names = view?.names ?? {};
    return snapshot.participants
      .map((participant) => ({
        pubkey: participant.pubkey,
        name: names[participant.pubkey]?.name ?? "Someone",
        isAgent: participant.isAgent,
        speaking: speakingSet.has(participant.pubkey),
        isSelf: participant.pubkey === selfPubkey,
      }))
      // Agents first, then by name — the order `presence.roster` uses, so the
      // two rails in one product cannot disagree about who leads.
      .sort((left, right) => {
        if (left.isAgent !== right.isAgent) return left.isAgent ? -1 : 1;
        return left.name.localeCompare(right.name);
      });
  }, [mine, live, speaking, view, selfPubkey]);

  // ── media ──────────────────────────────────────────────────────────────

  /**
   * Does an async result still belong to the call that asked for it?
   *
   * Read from a ref rather than from the rendered session, because every caller
   * is a callback that started several awaits ago and the closure it captured
   * is by definition out of date — which is the exact thing being guarded
   * against.
   */
  const ownsCurrent = useCallback(
    (huddleId: string, generation: number) =>
      current.current.huddleGeneration === generation &&
      (current.current.huddleId === null || current.current.huddleId === huddleId),
    [],
  );

  const sendCaption = useCallback(
    async (text: string) => {
      const active = current.current;
      if (!scope || !channelId || !active.huddleId || !selfPubkey) return;
      await sendCaptionAction({
        ...scopeArgs(scope),
        channelId,
        huddleId: active.huddleId,
        pubkey: selfPubkey,
        name: selfName,
        text,
      }).catch(() => {
        // Fire-and-forget, like typing: a dropped caption costs a line of a
        // pane that is explicitly not a record.
      });
    },
    [scope, channelId, selfPubkey, selfName, sendCaptionAction],
  );
  const sendCaptionRef = useRef(sendCaption);
  sendCaptionRef.current = sendCaption;


  const disconnectMedia = useCallback(() => {
    const handle = room.current;
    room.current = null;
    setMediaLive(false);
    setSpeaking([]);
    setLocalLevel(0);
    // The counter moves **before** the room is asked to leave, not after. A
    // caption tap or a level callback already in flight captured the old
    // generation, and the window between "leave() was called" and "leave()
    // resolved" is exactly when one of them lands. Bumping first makes that
    // frame arrive stale rather than arrive in a call the person has left.
    apply({ type: "invalidate_capture" });
    void handle?.leave().catch(() => {
      // A transport that cannot tear itself down cleanly must not block the
      // person from leaving. The log write is what actually removes them.
    });
  }, [apply]);

  const connectMedia = useCallback(
    async (huddleId: string, generation: number) => {
      if (!selfPubkey || !channelId) return;
      // The two counters answer two different questions and must not be
      // crossed: `generation` is the *huddle* lifetime this connect belongs to,
      // and this is the *session* generation a producer started under. Passing
      // one where the other is expected compares a number to an unrelated
      // number, which is a guard that is always false — a connect that never
      // completes, or a caption tap that never stops.
      const sessionGeneration = current.current.sessionGeneration;
      if (!transportCanCarryAudio(transport)) {
        setMediaError(transport.unavailableReason ?? "Voice is not available here.");
        return;
      }
      try {
        const handle = await transport.join(
          { huddleId, parentChannelId: channelId, pubkey: selfPubkey, displayName: selfName },
          {
            onSpeaking: (pubkeys) => setSpeaking([...pubkeys]),
            onLocalLevel: setLocalLevel,
            onCaption: (text) => {
              // Captured generation, checked at delivery: a recognizer's final
              // chunk outlives the hangup that cancelled it by however long the
              // chunk takes, and posting it would put a line into a call the
              // person has already left.
              if (current.current.sessionGeneration !== sessionGeneration) return;
              void sendCaptionRef.current(text);
            },
            onDisconnected: (reason) => {
              setMediaLive(false);
              setMediaError(reason);
            },
          },
        );
        if (!ownsCurrent(huddleId, generation)) {
          // Hung up while connecting. Tear the room down rather than keeping a
          // handle to a call nobody is in.
          void handle.leave().catch(() => {});
          return;
        }
        room.current = handle;
        setMediaLive(true);
        setMediaError(null);
        apply({ type: "confirm_media" });
      } catch (caught) {
        const reason =
          caught instanceof HuddleTransportUnavailable
            ? caught.message
            : caught instanceof Error
              ? caught.message
              : "The audio path could not be started.";
        // Not an error toast. With no provider this is the *expected* outcome
        // and the call is fine; the bar states it once, where it is relevant,
        // rather than interrupting.
        setMediaError(reason);
        setMediaLive(false);
      }
    },
    // `sendCaptionRef` is a ref and is deliberately absent: reading it at
    // delivery time rather than closing over the function is what lets a
    // caption land through whichever session is current.
    [transport, selfPubkey, selfName, channelId, apply, ownsCurrent],
  );

  // ── the log side ───────────────────────────────────────────────────────

  const start = useCallback(
    async (agentIds?: string[]) => {
      if (!scope || !channelId) return;
      if (!selfPubkey) {
        setError("Chat is still setting up your signing identity — try again in a moment.");
        return;
      }
      // A benign refusal (already in a call) is swallowed exactly as Buzz's
      // frontend swallows its own phase error: pressing Start twice means the
      // same thing the first press did.
      const step = apply({ type: "start", parentChannelId: channelId });
      if (!step.ok) {
        if (!step.benign) setError(step.reason);
        return;
      }
      const generation = step.session.huddleGeneration;
      setBusy(true);
      setError(null);
      try {
        const result = await startHuddle({
          ...scopeArgs(scope),
          channelId,
          ...(agentIds && agentIds.length > 0 ? { agentIds } : {}),
        });
        if (!ownsCurrent(result.huddleId, generation)) return;
        if (!result.created) {
          // Somebody else was already talking in here. Joining is what the
          // person meant; a second call in one room splits the conversation
          // with no way for anybody to tell which one the others are in.
          await joinHuddle({ ...scopeArgs(scope), channelId, huddleId: result.huddleId });
        }
        if (!ownsCurrent(result.huddleId, generation)) return;
        apply({ type: "joined", huddleId: result.huddleId });
        if (result.agentErrors.length > 0) {
          // Named, not swallowed. A machine that silently did not join is
          // indistinguishable from one that joined and has nothing to say.
          toast(result.agentErrors.map((entry) => entry.error).join(" "), { kind: "error" });
        }
        await connectMedia(result.huddleId, generation);
      } catch (caught) {
        if (ownsCurrent("", generation)) {
          apply({ type: "teardown" });
          setError(messageOf(caught, "That huddle could not be started."));
        }
      } finally {
        setBusy(false);
      }
    },
    [scope, channelId, selfPubkey, startHuddle, joinHuddle, connectMedia, ownsCurrent, apply, toast],
  );

  const join = useCallback(
    async (huddleId: string) => {
      if (!scope || !channelId) return;
      const step = apply({ type: "join", parentChannelId: channelId, huddleId });
      if (!step.ok) {
        if (!step.benign) setError(step.reason);
        return;
      }
      const generation = step.session.huddleGeneration;
      setBusy(true);
      setError(null);
      try {
        await joinHuddle({ ...scopeArgs(scope), channelId, huddleId });
        if (!ownsCurrent(huddleId, generation)) return;
        apply({ type: "joined", huddleId });
        await connectMedia(huddleId, generation);
      } catch (caught) {
        if (ownsCurrent(huddleId, generation)) {
          apply({ type: "teardown" });
          setError(messageOf(caught, "That huddle could not be joined."));
        }
      } finally {
        setBusy(false);
      }
    },
    [scope, channelId, joinHuddle, connectMedia, ownsCurrent, apply],
  );

  const leave = useCallback(async () => {
    const active = current.current;
    if (!scope || !channelId || !active.huddleId) {
      apply({ type: "teardown" });
      return;
    }
    apply({ type: "leave" });
    // Media first, always. A person who pressed Leave has stopped consenting to
    // their microphone being open, and that must not wait on a network round
    // trip — Buzz tears its media down before calling the backend for the same
    // reason.
    disconnectMedia();
    setBusy(true);
    try {
      await leaveHuddle({ ...scopeArgs(scope), channelId, huddleId: active.huddleId });
      apply({ type: "teardown" });
      setCaptions([]);
    } catch (caught) {
      // The bar stays up so the person can try again: the log still holds them
      // in the call, and pretending otherwise would show everyone else somebody
      // who is not there.
      setError(messageOf(caught, "Leaving failed — try again."));
    } finally {
      setBusy(false);
    }
  }, [scope, channelId, leaveHuddle, disconnectMedia, apply]);

  const endForEveryone = useCallback(async () => {
    const active = current.current;
    if (!scope || !channelId || !active.huddleId) return;
    setBusy(true);
    try {
      await endHuddle({ ...scopeArgs(scope), channelId, huddleId: active.huddleId });
      disconnectMedia();
      apply({ type: "teardown" });
      setCaptions([]);
    } catch (caught) {
      setError(messageOf(caught, "That huddle could not be ended."));
    } finally {
      setBusy(false);
    }
  }, [scope, channelId, endHuddle, disconnectMedia, apply]);

  const addAgent = useCallback(
    async (agentId: string, name: string) => {
      const active = current.current;
      if (!scope || !channelId || !active.huddleId) return;
      try {
        await addHuddleAgent({
          ...scopeArgs(scope),
          channelId,
          huddleId: active.huddleId,
          agentId,
        });
        toast(`${name} joined the huddle`);
      } catch (caught) {
        setError(messageOf(caught, `${name} could not join.`));
      }
    },
    [scope, channelId, addHuddleAgent, toast],
  );

  const react = useCallback(
    async (emoji: string) => {
      const active = current.current;
      if (!scope || !channelId || !active.huddleId || !selfPubkey) return;
      // Optimistic, and the echo is dropped on arrival (see the signal handler):
      // a reaction that appears a round trip after the press does not read as a
      // reaction, it reads as lag.
      setReactions((currentReactions) =>
        clip([
          ...currentReactions,
          {
            huddleId: active.huddleId as string,
            emoji,
            pubkey: selfPubkey,
            senderName: selfName,
            at: Date.now(),
          },
        ]),
      );
      try {
        await reactInHuddle({
          ...scopeArgs(scope),
          channelId,
          huddleId: active.huddleId,
          emoji,
        });
      } catch (caught) {
        setError(messageOf(caught, "That reaction did not send."));
      }
    },
    [scope, channelId, selfPubkey, selfName, reactInHuddle],
  );

  // ── realtime: reactions and captions ───────────────────────────────────

  const onSignal = useCallback(
    (signal: ChannelSignal) => {
      const active = current.current;
      if (!active.huddleId) return;
      const data = signal.data as Record<string, unknown>;
      if (data.huddleId !== active.huddleId) return;

      if (signal.name === "huddle.reaction") {
        // Your own reaction was already drawn optimistically; drawing the echo
        // as well makes every press burst twice.
        if (data.pubkey === selfPubkey) return;
        setReactions((currentReactions) =>
          clip([
            ...currentReactions,
            {
              huddleId: active.huddleId as string,
              emoji: String(data.emoji ?? ""),
              pubkey: String(data.pubkey ?? ""),
              senderName: String(data.senderName ?? "Someone"),
              at: Number(data.at) || Date.now(),
            },
          ]),
        );
        return;
      }

      if (signal.name === "huddle.caption") {
        setCaptions((lines) =>
          appendCaption(lines, {
            huddleId: active.huddleId as string,
            pubkey: String(data.pubkey ?? ""),
            name: String(data.name ?? "Someone"),
            isAgent: Boolean(data.isAgent),
            text: String(data.text ?? ""),
            at: Number(data.at) || Date.now(),
          }),
        );
      }
    },
    [selfPubkey],
  );

  const authorize = useCallback(async () => {
    if (!scope || !channelId) return null;
    return await issueToken({ ...scopeArgs(scope), channelId });
  }, [scope, channelId, issueToken]);

  const signalTransport = useAblyStream(
    // Subscribed only while in a call. A room's reaction channel open in every
    // room you have ever visited is a stream per room for nothing.
    scope && channelId && HUDDLE_JOINED_PHASES.has(session.phase)
      ? `huddle:${scope.scopeType}:${scope.scopeId}:${channelId}`
      : null,
    authorize,
    onSignal,
  );

  // Reactions expire on a timer only while there are any, for the reason
  // `use-typing.ts` gives: a permanent one-second interval in a chat client is
  // a permanent one-second wake-up on a phone.
  const hasReactions = reactions.length > 0;
  useEffect(() => {
    if (!hasReactions) return;
    const timer = setInterval(() => {
      const cutoff = Date.now() - REACTION_TTL_MS;
      setReactions((currentReactions) =>
        currentReactions.filter((entry) => entry.at > cutoff),
      );
    }, 1000);
    return () => clearInterval(timer);
  }, [hasReactions]);

  // ── the log ending the call under us ───────────────────────────────────
  //
  // Somebody else ended it, or the last human left, or it decayed past the
  // joinable window. The session has to follow the log rather than wait for a
  // local Leave that will never come — otherwise the bar sits there offering
  // controls for a call that is over.
  useEffect(() => {
    if (!HUDDLE_JOINED_PHASES.has(session.phase)) return;
    if (view === undefined || view === null) return;
    if (!session.huddleId) return;
    const snapshot = huddleById(view.huddles, session.huddleId);
    // **Absence is not evidence.** A missing snapshot means the query has not
    // caught up with the write that just happened, or the call's events fell
    // out of the read window — neither of which is the log saying the call is
    // over. Tearing down on absence would hang up on somebody in the gap
    // between their own join landing and the subscription delivering it, which
    // is a window every join passes through.
    if (!snapshot || snapshot.live) return;
    disconnectMedia();
    apply({ type: "teardown" });
    setCaptions([]);
  }, [view, session.phase, session.huddleId, disconnectMedia, apply]);

  // ── keeping the transport in step with the session ─────────────────────

  useEffect(() => {
    const handle = room.current;
    if (!handle) return;
    void handle.setMicrophoneEnabled(!session.micMuted).catch(() => {});
  }, [session.micMuted, mediaLive]);

  useEffect(() => {
    const handle = room.current;
    if (!handle) return;
    handle.setTransmitting(isTransmitting(session, true));
  }, [session, mediaLive]);

  useEffect(() => {
    room.current?.setInputGain(session.gain);
  }, [session.gain, mediaLive]);

  useEffect(() => {
    void room.current?.setAgentSpeechEnabled(!session.speakerMuted).catch(() => {});
  }, [session.speakerMuted, mediaLive]);

  useEffect(() => {
    void room.current?.setCaptionsEnabled(session.transcriptionEnabled).catch(() => {});
  }, [session.transcriptionEnabled, mediaLive]);

  useEffect(() => {
    void room.current?.setInputDevice(session.inputDeviceId).catch(() => {});
  }, [session.inputDeviceId, mediaLive]);

  useEffect(() => {
    void room.current?.setOutputDevice(session.outputDeviceId).catch(() => {});
  }, [session.outputDeviceId, mediaLive]);

  // ── push to talk ───────────────────────────────────────────────────────
  //
  // Bound **only** while the mode is push-to-talk and a call is up, which is
  // Buzz's rule for registering the OS shortcut: a chord reserved app-wide
  // fights every IDE the person also has open. `nextHuddleSession` refuses the
  // action outside the mode anyway, so this is defence in depth rather than the
  // only guard.
  const pttArmed =
    session.inputMode === "push_to_talk" && HUDDLE_JOINED_PHASES.has(session.phase);
  useEffect(() => {
    if (!pttArmed || typeof window === "undefined") return;
    const isChord = (event: KeyboardEvent) =>
      event.ctrlKey && (event.code === "Space" || event.key === " ");
    const down = (event: KeyboardEvent) => {
      if (!isChord(event)) return;
      event.preventDefault();
      apply({ type: "set_push_to_talk", held: true });
    };
    const up = (event: KeyboardEvent) => {
      if (!isChord(event) && event.key !== "Control") return;
      apply({ type: "set_push_to_talk", held: false });
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    // A blur releases the key. Without this, alt-tabbing while holding it
    // leaves the microphone open with nothing on screen saying so.
    const release = () => apply({ type: "set_push_to_talk", held: false });
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", release);
      release();
    };
  }, [pttArmed, apply]);

  // ── captions turn themselves on for machines (§1.13) ───────────────────

  const agentPresent = roster.some((entry) => entry.isAgent);
  useEffect(() => {
    if (!HUDDLE_JOINED_PHASES.has(session.phase)) return;
    if (!shouldAutoEnableTranscription(session, agentPresent)) return;
    // `byUser: false`, so this never counts as the person having chosen — the
    // next time they open a call with a machine in it, it turns itself on
    // again unless they said otherwise.
    apply({ type: "set_transcription", enabled: true, byUser: false });
  }, [agentPresent, session, apply]);

  // Leaving the room, or unmounting, must not leave the microphone open.
  useEffect(
    () => () => {
      room.current?.leave().catch(() => {});
      room.current = null;
    },
    [],
  );

  const value = useMemo<HuddleContextValue>(
    () => ({
      scope,
      channelId,
      session,
      transport,
      mediaLive,
      mediaNotice: mediaLive ? null : (mediaError ?? transport.unavailableReason),
      huddles,
      live,
      mine,
      roster,
      localLevel,
      captions,
      reactions,
      signalTransport,
      error,
      busy,
      transmitting: isTransmitting(session, mediaLive),
      start,
      join,
      leave,
      endForEveryone,
      addAgent,
      react,
      sendCaption,
      dispatch: apply,
      dismissError: () => setError(null),
    }),
    [
      scope,
      channelId,
      session,
      transport,
      mediaLive,
      mediaError,
      huddles,
      live,
      mine,
      roster,
      localLevel,
      captions,
      reactions,
      signalTransport,
      error,
      busy,
      start,
      join,
      leave,
      endForEveryone,
      addAgent,
      react,
      sendCaption,
      apply,
    ],
  );

  return <HuddleContext.Provider value={value}>{children}</HuddleContext.Provider>;
}

function clip(entries: HuddleReaction[]): HuddleReaction[] {
  return entries.length > MAX_VISIBLE_REACTIONS
    ? entries.slice(entries.length - MAX_VISIBLE_REACTIONS)
    : entries;
}

/**
 * The server's own sentence, or a fallback.
 *
 * A `ConvexError`'s `data` is the refusal we wrote, and it is always more
 * useful than "something went wrong" — every refusal in `convex/buzz/huddle.ts`
 * names what to do instead.
 */
function messageOf(caught: unknown, fallback: string): string {
  if (caught && typeof caught === "object" && "data" in caught) {
    const data = (caught as { data: unknown }).data;
    if (typeof data === "string" && data.length > 0) return data;
  }
  if (caught instanceof Error && caught.message) return caught.message;
  return fallback;
}

export type { VoiceInputMode };
