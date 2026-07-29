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
  normalizeAppearance,
  resolveTokens,
  type Appearance,
} from "@/lib/appearance";
import { applyTokens, morphTokens } from "@/lib/anime";

// The bridge between one person's stored preferences and the running app.
//
// Three states, deliberately distinct:
//
//   - **stored** — what Convex has. Arrives over a live subscription, so a
//     change made in another tab or on another device lands here without a
//     reload. This is the value that persists.
//   - **preview** — what a slider is currently showing. Not saved, applied
//     instantly, and thrown away on cancel. Dragging a slider must repaint the
//     app on the same frame; it must not write to the database sixty times a
//     second.
//   - **effective** — preview ?? stored ?? defaults. What the tokens are
//     resolved from.
//
// Saving is debounced and coalesced: someone who drags four sliders produces
// one write, not four hundred. And because the write lands back through the
// same subscription, the final state always comes from the server rather than
// from whatever the client happened to be holding.

const SAVE_DEBOUNCE_MS = 450;

type AppearanceContextValue = {
  /** What the UI is currently rendering with. */
  appearance: Appearance;
  /** What is actually saved — what a reload would give you. */
  stored: Appearance;
  /** True while a preview differs from what is stored. */
  dirty: boolean;
  /** Apply immediately without saving. For sliders. */
  preview: (patch: Partial<Appearance>) => void;
  /** Apply and persist. For presets, toggles, and the end of a drag. */
  commit: (patch: Partial<Appearance>) => void;
  /** Throw the preview away and go back to what's stored. */
  revert: () => void;
  /** Back to the shipped design. */
  reset: () => void;
};

const AppearanceContext = createContext<AppearanceContextValue | null>(null);

export function AppearanceProvider({ children }: { children: React.ReactNode }) {
  const remote = useQuery(api.appearance.forCurrentUser, {});
  const save = useMutation(api.appearance.save);
  const resetRemote = useMutation(api.appearance.reset);

  const [previewState, setPreviewState] = useState<Appearance | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The last value we wrote. Without it, our own echo coming back through the
  // subscription would look like a remote change and re-morph the whole UI.
  const lastWritten = useRef<string | null>(null);

  const stored = useMemo(
    () => (remote ? normalizeAppearance(remote) : DEFAULT_APPEARANCE),
    [remote],
  );
  const effective = previewState ?? stored;

  // ── Apply ──
  // The first application is instant (no morph on page load — the app should
  // not animate itself into existence every navigation), and every subsequent
  // change is morphed.
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

  // The layout half: attributes rather than tokens, because "where is the
  // sidebar" is a structural question the shell answers with CSS, not a value
  // to interpolate.
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.sidebar = effective.sidebarPosition;
    root.dataset.density = effective.density;
    root.dataset.surface = effective.surface;
  }, [effective.sidebarPosition, effective.density, effective.surface]);

  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);

  const persist = useCallback(
    (next: Appearance) => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        lastWritten.current = JSON.stringify(next);
        void save({ appearance: next }).catch(() => {
          // A failed save is a preference that didn't stick, not a broken app.
          // The preview stays, so nothing appears to have been lost, and the
          // next change tries again.
        });
      }, SAVE_DEBOUNCE_MS);
    },
    [save],
  );

  const preview = useCallback(
    (patch: Partial<Appearance>) => {
      setPreviewState((current) =>
        normalizeAppearance({ ...(current ?? stored), ...patch }),
      );
    },
    [stored],
  );

  const commit = useCallback(
    (patch: Partial<Appearance>) => {
      const next = normalizeAppearance({ ...(previewState ?? stored), ...patch });
      setPreviewState(next);
      persist(next);
    },
    [persist, previewState, stored],
  );

  const revert = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setPreviewState(null);
  }, []);

  const reset = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setPreviewState(null);
    lastWritten.current = null;
    void resetRemote({}).catch(() => {});
  }, [resetRemote]);

  // Once the server agrees with the preview, drop the preview — from then on
  // the subscription is the source of truth again.
  useEffect(() => {
    if (!previewState || remote === undefined) return;
    if (JSON.stringify(stored) === JSON.stringify(previewState)) {
      setPreviewState(null);
    }
  }, [previewState, remote, stored]);

  const value = useMemo<AppearanceContextValue>(
    () => ({
      appearance: effective,
      stored,
      dirty:
        previewState !== null &&
        JSON.stringify(previewState) !== JSON.stringify(stored),
      preview,
      commit,
      revert,
      reset,
    }),
    [commit, effective, preview, previewState, reset, revert, stored],
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
 * Falls back to the defaults outside a provider rather than throwing: a
 * component rendered in a test or in a surface that has no provider should
 * render the shipped design, not crash.
 */
export function useAppearance(): AppearanceContextValue {
  const ctx = useContext(AppearanceContext);
  if (ctx) return ctx;
  const noop = () => {};
  return {
    appearance: DEFAULT_APPEARANCE,
    stored: DEFAULT_APPEARANCE,
    dirty: false,
    preview: noop,
    commit: noop,
    revert: noop,
    reset: noop,
  };
}
