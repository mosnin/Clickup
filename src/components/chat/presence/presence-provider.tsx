"use client";

// The heartbeat, and the roster it feeds.
//
// Two halves that have to live together because they are the same fact seen
// from both ends: this tab tells the community it is here every sixty seconds,
// and reads back everyone else's beat over the same Convex subscription. There
// is no realtime service in this file — a heartbeat row *is* a live feed once
// Convex pushes query results to subscribers, which is the whole reason
// presence is a table rather than a broadcast (see `convex/presence.ts`).
//
// Three details that are not incidental:
//
//   • **Activity lives in a ref, never in state.** Every pointer move and
//     every keystroke anywhere in the app is a signal, and holding that in
//     React state re-renders the application root on each one. Only the
//     *derived* status — a value that changes maybe twice an hour — is state.
//   • **Away means the human is not at the machine.** Window visibility is not
//     an input. Somebody reading a spec in another tab with the room open
//     beside them is at their desk, and a dot that says otherwise is a dot
//     people learn to ignore.
//   • **Offline is an absence, not a claim.** Choosing "Appear offline" (or
//     closing the tab) deletes the row rather than writing `"offline"` into
//     it, exactly as Buzz's Redis `DEL` does — so there is one representation
//     of "not here" and no way for a stale one to contradict it.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useMutation, useQuery } from "convex/react";
import type { ChatScope } from "@/lib/buzz/channel-types";
import {
  PRESENCE_HEARTBEAT_INTERVAL_MS,
  parsePresencePreference,
  presencePreferenceKey,
  resolveAutomaticPresenceStatus,
  resolvePreferredStatus,
  type PresencePreference,
  type PresenceStatus,
} from "@/lib/buzz/presence";
import {
  heartbeatRef,
  leaveRef,
  myPubkeyRef,
  rosterRef,
  scopeArgs,
  type RosterEntry,
  type RosterSeed,
} from "./refs";

/** How often in-app activity may move the "last seen a human" mark. */
const ACTIVITY_THROTTLE_MS = 1_000;

/**
 * OS-wide idle, when the platform exposes it.
 *
 * A desktop shell can answer "has this person touched anything in ten
 * minutes"; a browser can only answer "in this tab". Buzz reads the OS and
 * falls back; we have no desktop bridge yet (D10 ships one later), so this
 * returns null and the in-app fallback is what runs. It exists as a seam
 * rather than a TODO because the fallback is *already* the code path that has
 * to be right — adding the OS reading later changes one function.
 */
function osIdleSeconds(): number | null {
  return null;
}

// ---------------------------------------------------------------------------
// My own presence
// ---------------------------------------------------------------------------

export type MyPresence = {
  status: PresenceStatus;
  preference: PresencePreference;
  setPreference: (next: PresencePreference) => void;
};

/**
 * Publish my liveness while this tab is open.
 *
 * The heartbeat writes on a 60s interval *and* immediately whenever the
 * derived status changes, because the interval alone means going away is
 * visible up to a minute late and coming back up to a minute late in the other
 * direction — which is precisely the lag that makes people distrust a dot.
 */
export function useMyPresence(scope: ChatScope | null, pubkey: string | null): MyPresence {
  const heartbeat = useMutation(heartbeatRef);
  const goOffline = useMutation(leaveRef);

  const [preference, setPreferenceState] = useState<PresencePreference>("auto");
  const [status, setStatus] = useState<PresenceStatus>("online");
  const lastActivityAt = useRef(Date.now());

  // The override is read after mount: localStorage does not exist on the
  // server, and reading it during the first render makes the markup disagree
  // with what was sent.
  useEffect(() => {
    if (!pubkey) return;
    try {
      setPreferenceState(parsePresencePreference(localStorage.getItem(presencePreferenceKey(pubkey))));
    } catch {
      /* private mode — an override is nice to have, not load-bearing */
    }
  }, [pubkey]);

  const setPreference = useCallback(
    (next: PresencePreference) => {
      setPreferenceState(next);
      if (!pubkey) return;
      try {
        localStorage.setItem(presencePreferenceKey(pubkey), next);
      } catch {
        /* as above */
      }
    },
    [pubkey],
  );

  // Activity. Capture phase so a component that stops propagation — a menu, a
  // drag handle — cannot make the person using it look idle. `pointermove` and
  // `wheel` are passive: they fire continuously and must never be able to
  // delay a scroll.
  useEffect(() => {
    function note() {
      const now = Date.now();
      if (now - lastActivityAt.current < ACTIVITY_THROTTLE_MS) return;
      lastActivityAt.current = now;
    }
    const options = { capture: true, passive: true } as const;
    const events = ["pointerdown", "pointermove", "wheel", "keydown", "focus"] as const;
    for (const name of events) window.addEventListener(name, note, options);
    return () => {
      for (const name of events) window.removeEventListener(name, note, options);
    };
  }, []);

  // Re-derive on a short tick. Cheap — it is arithmetic over a ref — and it is
  // what turns "ten minutes of nothing" into a state change without an event
  // to hang it on. `setStatus` with an unchanged value is a no-op in React, so
  // this does not re-render anything on the 99% of ticks that decide nothing.
  useEffect(() => {
    function derive() {
      const now = Date.now();
      const automatic = resolveAutomaticPresenceStatus(
        { osIdleSeconds: osIdleSeconds(), lastActivityAt: lastActivityAt.current },
        now,
      );
      setStatus(resolvePreferredStatus(preference, automatic));
    }
    derive();
    const timer = setInterval(derive, 15_000);
    return () => clearInterval(timer);
  }, [preference]);

  // Publish. One effect for both triggers — the immediate write on a status
  // change and the keep-alive — because they are the same call and splitting
  // them is how a status change publishes twice.
  useEffect(() => {
    if (!scope) return;
    const args = scopeArgs(scope);

    if (status === "offline") {
      void goOffline(args).catch(() => {});
      return;
    }

    let cancelled = false;
    function beat() {
      if (cancelled) return;
      // Fire-and-forget. A failed heartbeat costs one window of freshness and
      // the TTL is three windows wide, so it recovers on its own; surfacing it
      // would be a toast about nothing the reader can act on.
      void heartbeat({ ...args, state: status === "away" ? "away" : "online" }).catch(() => {});
    }
    beat();
    const timer = setInterval(beat, PRESENCE_HEARTBEAT_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [scope, status, heartbeat, goOffline]);

  // Leaving. `pagehide` rather than `beforeunload`: it fires on mobile when
  // the app is backgrounded, which `beforeunload` does not, and a phone that
  // never says goodbye leaves a green dot up for three minutes after the
  // person put it in their pocket.
  useEffect(() => {
    if (!scope) return;
    const args = scopeArgs(scope);
    function bye() {
      void goOffline(args).catch(() => {});
    }
    window.addEventListener("pagehide", bye);
    return () => {
      window.removeEventListener("pagehide", bye);
      bye();
    };
  }, [scope, goOffline]);

  return { status, preference, setPreference };
}

/** The signed-in reader's Chat pubkey, or null before the mint bootstrap ran. */
export function useMyPubkey(): string | null {
  const identity = useQuery(myPubkeyRef, {});
  return identity?.pubkey ?? null;
}

// ---------------------------------------------------------------------------
// Everyone else
// ---------------------------------------------------------------------------

export type RosterState = {
  /** Keyed by actorId. Absent means "not in the roster", which reads offline. */
  entries: ReadonlyMap<string, RosterEntry>;
  statusOf: (actorId: string) => PresenceStatus;
  /** Null when there is none, or when the one that exists has lapsed. */
  statusTextOf: (actorId: string) => { text: string; emoji: string } | null;
  loading: boolean;
};

const EMPTY_ROSTER: RosterState = {
  entries: new Map(),
  statusOf: () => "offline",
  statusTextOf: () => null,
  loading: true,
};

const RosterContext = createContext<RosterState | null>(null);

/**
 * One roster subscription for a whole surface.
 *
 * A context rather than a hook per row, because the alternative is forty
 * member rows each holding their own subscription to the same query — which is
 * forty websocket subscriptions to answer one question, and forty re-renders
 * every time anybody's dot moves.
 */
export function PresenceProvider({
  scope,
  seed,
  children,
}: {
  scope: ChatScope | null;
  /** People to show as offline when they have no row. Usually a member list. */
  seed?: RosterSeed[];
  children: ReactNode;
}) {
  const value = useCommunityRoster(scope, seed);
  return <RosterContext.Provider value={value}>{children}</RosterContext.Provider>;
}

/** The roster, from inside a `PresenceProvider`. Empty (and offline) outside one. */
export function useRoster(): RosterState {
  return useContext(RosterContext) ?? EMPTY_ROSTER;
}

/**
 * Read the roster directly.
 *
 * Exported for the surfaces that are not inside a provider — the profile card,
 * a one-off member sheet — and used by the provider itself, so there is one
 * implementation rather than two that can disagree about what an absent row
 * means.
 */
export function useCommunityRoster(
  scope: ChatScope | null,
  seed?: RosterSeed[],
): RosterState {
  // Serialized, because a caller that builds the array inline hands a new
  // identity every render and `useQuery` would tear down and rebuild the
  // subscription on each one.
  const seedKey = useMemo(
    () => (seed ?? []).map((s) => `${s.actorType}:${s.actorId}`).sort().join(","),
    [seed],
  );
  const seedArg = useMemo<RosterSeed[]>(
    () =>
      seedKey
        ? seedKey.split(",").map((entry) => {
            const [actorType, ...rest] = entry.split(":");
            return {
              actorType: actorType === "agent" ? "agent" : "user",
              actorId: rest.join(":"),
            };
          })
        : [],
    [seedKey],
  );

  const rows = useQuery(
    rosterRef,
    scope ? { ...scopeArgs(scope), ...(seedArg.length ? { seed: seedArg } : {}) } : "skip",
  );

  return useMemo(() => {
    const entries = new Map<string, RosterEntry>();
    for (const row of rows ?? []) entries.set(row.actorId, row);
    const now = Date.now();
    return {
      entries,
      loading: rows === undefined,
      statusOf: (actorId: string) => entries.get(actorId)?.status ?? "offline",
      statusTextOf: (actorId: string) => {
        const row = entries.get(actorId);
        if (!row) return null;
        if (!row.statusText && !row.statusEmoji) return null;
        // Belt and braces: the server already drops a lapsed status, but a
        // subscription held open across the expiry would otherwise keep
        // showing it until something else invalidated the query.
        if (row.statusExpiresAt !== null && row.statusExpiresAt <= now) return null;
        return { text: row.statusText ?? "", emoji: row.statusEmoji ?? "" };
      },
    };
  }, [rows]);
}
