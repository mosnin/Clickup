"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useUser } from "@clerk/nextjs";
import { useAction, useMutation, useQuery } from "convex/react";
import { useToast } from "@/components/toast";
import { errorMessage } from "@/lib/errors";
import { api } from "@convex/_generated/api";
import {
  DEFAULT_APPEARANCE,
  PLACE_KEYS,
  clearKeys,
  normalizePatch,
  prunePatch,
  resolveLayered,
  resolveTokens,
  type Appearance,
  type AppearanceKey,
  type AppearanceLayerId,
  type AppearancePatch,
} from "@/lib/appearance";
import { applyTokens, morphTokens } from "@/lib/anime";
import { useActiveSpace, type ActiveSpace } from "@/lib/use-active-space";
import { useAblyStream } from "@/lib/use-ably-channel";

// The bridge between stored preferences and the running app.
//
// Three writers decide what you see — the product's defaults, the space you are
// standing in, and you — and this holds all three at once. What it adds on top
// of `resolveLayered` is time: which layer an edit is aimed at, what a slider is
// doing mid-drag, and the fact that a change of room should look like a change
// of room rather than a cut.
//
// Four states, deliberately distinct:
//
//   - **stored** — what Convex has, arriving over a live subscription. A change
//     made in another tab, on another device, or by an admin re-theming the
//     space lands here without a reload.
//   - **space** — the room you are in, resolved from the URL.
//   - **preview** — what a slider is currently showing. Never written. Dragging
//     must repaint on the same frame and must not write sixty times a second.
//   - **effective** — the resolution of all of it, which the tokens come from.
//
// Saving is debounced and coalesced: someone dragging four sliders produces one
// write. Because the write lands back through the subscription, the final state
// always comes from the server rather than from whatever the client was holding.

const SAVE_DEBOUNCE_MS = 450;
/** How often an in-flight space change is broadcast while someone drags. */
const LOOK_SIGNAL_THROTTLE_MS = 90;
/** How long a watched drag survives without a fresh frame. */
const LOOK_SIGNAL_TTL_MS = 3_000;

/**
 * This tab, for one session.
 *
 * Ably echoes a publisher its own messages, and a publisher already has the
 * value locally. Without an origin the echo would re-apply after the local
 * preview had been cleared, so the slider would twitch back at the end of every
 * drag. Per-tab rather than per-user, because two tabs are two draggers.
 */
const ORIGIN = Math.random().toString(36).slice(2);

/** Which layer an edit is aimed at. */
export type AppearanceScope = "personal" | "space" | "personalSpace";

export type AppearanceContextValue = {
  /** What the UI is rendering with, preview included. */
  appearance: Appearance;
  /** Which layer each value came from — what makes the controls legible. */
  sources: Record<AppearanceKey, AppearanceLayerId>;
  /** The room, or null on a surface that belongs to no space. */
  space: ActiveSpace | null;
  /** The stored patch for one scope: exactly what has been set *there*. */
  patchFor: (scope: AppearanceScope) => AppearancePatch;
  /** Can this person change what everyone in the space sees? */
  mayThemeSpace: boolean;
  /** Which scopes are available to edit right now. */
  availableScopes: AppearanceScope[];
  /**
   * Apply immediately without saving. For sliders mid-drag.
   *
   * The scope is what decides whether the drag is also broadcast: tuning a
   * shared space is worth watching, tuning your own settings is not.
   */
  preview: (patch: AppearancePatch, scope?: AppearanceScope) => void;
  /** Apply and persist to one layer. For presets, toggles, end of a drag. */
  commit: (patch: AppearancePatch, scope: AppearanceScope) => void;
  /** Stop setting these keys here, so they inherit again. */
  clear: (keys: readonly AppearanceKey[], scope: AppearanceScope) => void;
  /** Clear a whole layer. */
  reset: (scope: AppearanceScope) => void;
  /** Throw the preview away. */
  revert: () => void;
  dirty: boolean;
  /** Who is changing this space's look right now, if anyone. */
  liveEditor: string | null;
};

const AppearanceContext = createContext<AppearanceContextValue | null>(null);

export function AppearanceProvider({ children }: { children: React.ReactNode }) {
  const remote = useQuery(api.appearance.forCurrentUser, {});
  const space = useActiveSpace();
  const { toast } = useToast();
  const save = useMutation(api.appearance.save);
  const resetRemote = useMutation(api.appearance.reset);
  const setSpaceTheme = useMutation(api.appearance.setSpaceTheme);

  const [previewPatch, setPreviewPatch] = useState<AppearancePatch | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Someone else's drag ──
  //
  // The committed theme needs nothing here: it is a Convex row and already
  // arrives live. This is the in-flight value, which no query can carry.
  const { user } = useUser();
  // Spectators are told who is dragging, so a room changing under them reads as
  // a person doing something rather than as a glitch.
  const viewerName = user?.firstName || user?.fullName || "Someone";
  const lookSignal = useAction(api.realtime.spaceLookSignal);
  const lookToken = useAction(api.realtime.spaceLookToken);
  const [live, setLive] = useState<{
    patch: AppearancePatch;
    byName: string;
  } | null>(null);
  const liveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const broadcastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastBroadcast = useRef(0);

  const spaceId = space?.spaceId ?? null;
  useAblyStream(
    spaceId,
    () =>
      lookToken({
        spaceId: spaceId as Parameters<typeof lookToken>[0]["spaceId"],
      }),
    (signal) => {
      if (signal.name !== "look.preview") return;
      const data = signal.data as {
        patch?: unknown;
        origin?: string;
        byName?: string;
      };
      // Our own echo. We already have this value locally, and applying it after
      // the local preview cleared would make the slider twitch.
      if (data.origin === ORIGIN) return;
      if (liveTimer.current) clearTimeout(liveTimer.current);
      if (!data.patch) {
        setLive(null);
        return;
      }
      setLive({
        patch: normalizePatch(data.patch, PLACE_KEYS),
        byName: data.byName || "Someone",
      });
      // A drag that stops mid-flight — a closed tab, a dropped connection —
      // must not leave the room stuck on an uncommitted look.
      liveTimer.current = setTimeout(() => setLive(null), LOOK_SIGNAL_TTL_MS);
    },
  );

  // Leaving the space drops whatever was being watched there.
  useEffect(() => {
    setLive(null);
    if (liveTimer.current) clearTimeout(liveTimer.current);
  }, [spaceId]);

  useEffect(
    () => () => {
      if (liveTimer.current) clearTimeout(liveTimer.current);
      if (broadcastTimer.current) clearTimeout(broadcastTimer.current);
    },
    [],
  );

  // ── The stored layers ──
  const personalPatch = useMemo<AppearancePatch>(() => {
    if (!remote) return {};
    // A row written before space themes existed holds all eleven keys whether
    // or not the person chose them. Taken literally it would pin everything and
    // make space themes invisible to every existing user.
    return remote.patchVersion >= 2
      ? normalizePatch(remote.personal)
      : prunePatch(remote.personal);
  }, [remote]);

  const storedSpacePatch = useMemo<AppearancePatch>(
    () => normalizePatch(space?.theme, PLACE_KEYS),
    [space?.theme],
  );

  // A watched drag stands in for the stored theme at the *space* layer, not on
  // top of everything. That is what keeps it honest: someone else tuning the
  // room still loses to your own override of that room, and can no more touch
  // your type size than the saved theme could.
  const spacePatch = live ? live.patch : storedSpacePatch;

  const personalSpacePatch = useMemo<AppearancePatch>(() => {
    if (!remote || !space) return {};
    const stored = (remote.spaceOverrides ?? {})[space.spaceId];
    return normalizePatch(stored, PLACE_KEYS);
  }, [remote, space]);

  const resolved = useMemo(
    () =>
      resolveLayered({
        personal: personalPatch,
        space: spacePatch,
        personalSpace: personalSpacePatch,
      }),
    [personalPatch, personalSpacePatch, spacePatch],
  );

  // A preview sits on top of everything, so a drag always visibly moves even
  // when the value being dragged is shadowed by a narrower layer. The studio is
  // responsible for saying so; the slider is not responsible for feeling dead.
  const effective = useMemo<Appearance>(() => {
    if (!previewPatch) return resolved.appearance;
    return { ...resolved.appearance, ...normalizePatch(previewPatch) };
  }, [previewPatch, resolved.appearance]);

  // ── Apply ──
  // The first application is instant: the app should not animate itself into
  // existence on every navigation. Everything after is morphed, which is what
  // makes walking into a differently-themed space read as one room becoming
  // another rather than as a page reload.
  const applied = useRef(false);
  useEffect(() => {
    const tokens = resolveTokens(effective);
    if (!applied.current) {
      applied.current = true;
      applyTokens(tokens);
      return;
    }
    morphTokens(tokens);
  }, [effective]);

  // The structural half: attributes rather than tokens, because "where is the
  // sidebar" is a question the shell answers with CSS, not a value to
  // interpolate.
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.sidebar = effective.sidebarPosition;
    root.dataset.density = effective.density;
    root.dataset.surface = effective.surface;
    // How a repeating row is drawn is a CSS question — dividers, gaps, whether
    // each row is its own surface — so it rides an attribute like the others.
    // Chart style and agent icon are not: they change which element gets
    // rendered, so components read them from this context instead.
    root.dataset.listStyle = effective.listStyle;
  }, [
    effective.sidebarPosition,
    effective.density,
    effective.surface,
    effective.listStyle,
  ]);

  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    },
    [],
  );

  // ── Write ──
  const patchFor = useCallback(
    (scope: AppearanceScope): AppearancePatch => {
      if (scope === "personal") return personalPatch;
      // The stored value, not a teammate's in-flight one: "what is set here"
      // must not flicker while someone else drags.
      if (scope === "space") return storedSpacePatch;
      return personalSpacePatch;
    },
    [personalPatch, personalSpacePatch, storedSpacePatch],
  );

  const persist = useCallback(
    (scope: AppearanceScope, patch: AppearancePatch) => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      const spaceId = space?.spaceId;
      saveTimer.current = setTimeout(() => {
        // Say so, for the same reason the component-style writer does: the
        // preview stays on screen after a failed write, so silence made a
        // dropped save indistinguishable from a successful one.
        const failed = (e: unknown) =>
          toast(errorMessage(e, "That didn't save"), { kind: "error" });
        if (scope === "personal") {
          void save({ patch }).catch(failed);
        } else if (!spaceId) {
          // A wiring bug rather than something a person can do — but it used
          // to drop the write without a word, so it says something now.
          toast("Open a space to change how it looks there", { kind: "error" });
        } else if (scope === "space") {
          void setSpaceTheme({
            spaceId: spaceId as Parameters<typeof setSpaceTheme>[0]["spaceId"],
            theme: patch,
          }).catch(failed);
        } else {
          void save({
            patch,
            spaceId: spaceId as Parameters<typeof save>[0]["spaceId"],
          }).catch(failed);
        }
      }, SAVE_DEBOUNCE_MS);
    },
    [save, setSpaceTheme, space?.spaceId, toast],
  );

  /**
   * Broadcast an in-flight space change, at most every ~90ms.
   *
   * Throttled with a trailing send rather than dropped frames only: the last
   * value of a drag is the one a spectator must end on, and a leading-edge
   * throttle would strand them on whatever the second-to-last frame was.
   */
  const broadcast = useCallback(
    (patch: AppearancePatch | null) => {
      if (!spaceId || !space?.mayTheme) return;
      const send = () => {
        lastBroadcast.current = Date.now();
        void lookSignal({
          spaceId: spaceId as Parameters<typeof lookSignal>[0]["spaceId"],
          patch,
          origin: ORIGIN,
          byName: viewerName,
        }).catch(() => {
          // Ably unconfigured, or a refused signal. The save still lands, so
          // spectators simply see the change when it commits.
        });
      };
      if (broadcastTimer.current) clearTimeout(broadcastTimer.current);
      const since = Date.now() - lastBroadcast.current;
      if (since >= LOOK_SIGNAL_THROTTLE_MS) {
        send();
        return;
      }
      broadcastTimer.current = setTimeout(send, LOOK_SIGNAL_THROTTLE_MS - since);
    },
    [lookSignal, space?.mayTheme, spaceId, viewerName],
  );

  const preview = useCallback(
    (patch: AppearancePatch, scope: AppearanceScope = "personal") => {
      setPreviewPatch((current) => ({ ...(current ?? {}), ...patch }));
      if (scope === "space") broadcast(normalizePatch(patch, PLACE_KEYS));
    },
    [broadcast],
  );

  const commit = useCallback(
    (patch: AppearancePatch, scope: AppearanceScope) => {
      // A space may only be given place keys. Dropping them here as well as in
      // the resolver keeps a mis-wired control from writing a row that quietly
      // never applies.
      const allowed =
        scope === "personal" ? normalizePatch(patch) : normalizePatch(patch, PLACE_KEYS);
      setPreviewPatch((current) => ({ ...(current ?? {}), ...allowed }));
      persist(scope, { ...patchFor(scope), ...allowed });
      // The committed value arrives on everyone's subscription in a moment, so
      // retract the in-flight one rather than letting it expire on a timer.
      if (scope === "space") broadcast(null);
    },
    [broadcast, patchFor, persist],
  );

  const clear = useCallback(
    (keys: readonly AppearanceKey[], scope: AppearanceScope) => {
      // Clearing the preview for these keys too, or the slider would keep
      // showing the value that was just given back to the layer beneath.
      setPreviewPatch((current) =>
        current ? clearKeys(current, keys) : current,
      );
      persist(scope, clearKeys(patchFor(scope), keys));
    },
    [patchFor, persist],
  );

  const reset = useCallback(
    (scope: AppearanceScope) => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      setPreviewPatch(null);
      const spaceId = space?.spaceId;
      if (scope === "personal") {
        void resetRemote({}).catch(() => {});
        return;
      }
      if (!spaceId) return;
      if (scope === "space") {
        void setSpaceTheme({
          spaceId: spaceId as Parameters<typeof setSpaceTheme>[0]["spaceId"],
          theme: {},
        }).catch(() => {});
        return;
      }
      void resetRemote({
        spaceId: spaceId as Parameters<typeof resetRemote>[0]["spaceId"],
      }).catch(() => {});
    },
    [resetRemote, setSpaceTheme, space?.spaceId],
  );

  const revert = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setPreviewPatch(null);
  }, []);

  // Once the server agrees with the preview, drop it — from then on the
  // subscription is the source of truth again, which is what lets a change made
  // elsewhere take over cleanly.
  const storedJson = JSON.stringify(resolved.appearance);
  useEffect(() => {
    if (!previewPatch || remote === undefined) return;
    const merged = JSON.stringify({
      ...resolved.appearance,
      ...normalizePatch(previewPatch),
    });
    if (merged === storedJson) setPreviewPatch(null);
  }, [previewPatch, remote, resolved.appearance, storedJson]);

  const availableScopes = useMemo<AppearanceScope[]>(() => {
    if (!space) return ["personal"];
    const scopes: AppearanceScope[] = ["personal"];
    if (space.mayTheme) scopes.push("space");
    scopes.push("personalSpace");
    return scopes;
  }, [space]);

  const value = useMemo<AppearanceContextValue>(
    () => ({
      appearance: effective,
      sources: resolved.sources,
      space,
      patchFor,
      mayThemeSpace: space?.mayTheme ?? false,
      availableScopes,
      preview,
      commit,
      clear,
      reset,
      revert,
      dirty: previewPatch !== null && JSON.stringify(effective) !== storedJson,
      liveEditor: live?.byName ?? null,
    }),
    [
      live,
      availableScopes,
      clear,
      commit,
      effective,
      patchFor,
      preview,
      previewPatch,
      reset,
      resolved.sources,
      revert,
      space,
      storedJson,
    ],
  );

  return (
    <AppearanceContext.Provider value={value}>
      {children}
    </AppearanceContext.Provider>
  );
}

/**
 * The current appearance.
 *
 * Falls back to the shipped design outside a provider rather than throwing: a
 * component rendered in a test, or on a surface with no provider, should render
 * the design we ship, not crash.
 */
export function useAppearance(): AppearanceContextValue {
  const ctx = useContext(AppearanceContext);
  if (ctx) return ctx;
  const noop = () => {};
  const sources = {} as Record<AppearanceKey, AppearanceLayerId>;
  for (const key of Object.keys(DEFAULT_APPEARANCE) as AppearanceKey[]) {
    sources[key] = "default";
  }
  return {
    appearance: DEFAULT_APPEARANCE,
    sources,
    space: null,
    patchFor: () => ({}),
    mayThemeSpace: false,
    availableScopes: ["personal"],
    preview: noop,
    commit: noop,
    clear: noop,
    reset: noop,
    revert: noop,
    dirty: false,
    liveEditor: null,
  };
}
