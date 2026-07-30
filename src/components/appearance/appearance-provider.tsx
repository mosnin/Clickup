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
import { useMutation, useQuery } from "convex/react";
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
  /** Apply immediately without saving. For sliders mid-drag. */
  preview: (patch: AppearancePatch) => void;
  /** Apply and persist to one layer. For presets, toggles, end of a drag. */
  commit: (patch: AppearancePatch, scope: AppearanceScope) => void;
  /** Stop setting these keys here, so they inherit again. */
  clear: (keys: readonly AppearanceKey[], scope: AppearanceScope) => void;
  /** Clear a whole layer. */
  reset: (scope: AppearanceScope) => void;
  /** Throw the preview away. */
  revert: () => void;
  dirty: boolean;
};

const AppearanceContext = createContext<AppearanceContextValue | null>(null);

export function AppearanceProvider({ children }: { children: React.ReactNode }) {
  const remote = useQuery(api.appearance.forCurrentUser, {});
  const space = useActiveSpace();
  const save = useMutation(api.appearance.save);
  const resetRemote = useMutation(api.appearance.reset);
  const setSpaceTheme = useMutation(api.appearance.setSpaceTheme);

  const [previewPatch, setPreviewPatch] = useState<AppearancePatch | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  const spacePatch = useMemo<AppearancePatch>(
    () => normalizePatch(space?.theme, PLACE_KEYS),
    [space?.theme],
  );

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
  }, [effective.sidebarPosition, effective.density, effective.surface]);

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
      if (scope === "space") return spacePatch;
      return personalSpacePatch;
    },
    [personalPatch, personalSpacePatch, spacePatch],
  );

  const persist = useCallback(
    (scope: AppearanceScope, patch: AppearancePatch) => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      const spaceId = space?.spaceId;
      saveTimer.current = setTimeout(() => {
        const failed = () => {
          // A failed save is a preference that didn't stick, not a broken app.
          // The preview stays, so nothing appears lost, and the next change
          // tries again.
        };
        if (scope === "personal") {
          void save({ patch }).catch(failed);
        } else if (!spaceId) {
          // Nothing to scope it to; the studio hides these scopes off a space.
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
    [save, setSpaceTheme, space?.spaceId],
  );

  const preview = useCallback((patch: AppearancePatch) => {
    setPreviewPatch((current) => ({ ...(current ?? {}), ...patch }));
  }, []);

  const commit = useCallback(
    (patch: AppearancePatch, scope: AppearanceScope) => {
      // A space may only be given place keys. Dropping them here as well as in
      // the resolver keeps a mis-wired control from writing a row that quietly
      // never applies.
      const allowed =
        scope === "personal" ? normalizePatch(patch) : normalizePatch(patch, PLACE_KEYS);
      setPreviewPatch((current) => ({ ...(current ?? {}), ...allowed }));
      persist(scope, { ...patchFor(scope), ...allowed });
    },
    [patchFor, persist],
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
    }),
    [
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
  };
}
