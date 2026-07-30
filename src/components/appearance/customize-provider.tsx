"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

// Customising happens *on* your work, not somewhere else.
//
// The generic answer to "let people change how the app looks" is a settings
// page, and it is wrong here for three reasons that all show up the moment you
// use one. It shows fake data, so you judge a look against numbers that are not
// yours. It is remote from context, so you cannot see the change land on the
// list you were actually reading. And it makes you translate from an option's
// *name* to its *effect* — which is fine if you write stylesheets and useless
// if you do not.
//
// So there is no page. There is a mode: press Customise and the app you are
// already looking at — your projects, your tasks, your charts — gains an
// inspector. Click any panel and the inspector becomes about that panel.
// Change something and it changes under your cursor, in your data, at the size
// you actually read it.
//
// Two properties make that honest rather than cosmetic:
//
//   - **The rail pushes, it never overlays.** A panel hidden behind the
//     inspector is a panel you are editing blind. The shell reflows.
//   - **Selection is the thing itself.** You do not pick "Panel 3" from a list;
//     you click the panel. Anything editable announces itself with
//     `data-customize-id`, and the delegated handler here turns a click into a
//     selection instead of a navigation.

export type CustomizeSelection = {
  /** Stable id — a screen widget id, or a panel definition id. */
  id: string;
  /** What to call it in the inspector. */
  label: string;
  /** Which screen it lives on, so an override is scoped to that screen. */
  screenKey: string | null;
};

export type CustomizeContextValue = {
  active: boolean;
  /** Turn the mode on or off. */
  setActive: (active: boolean) => void;
  selection: CustomizeSelection | null;
  select: (selection: CustomizeSelection | null) => void;
};

const CustomizeContext = createContext<CustomizeContextValue | null>(null);

export function CustomizeProvider({ children }: { children: React.ReactNode }) {
  const [active, setActiveState] = useState(false);
  const [selection, setSelection] = useState<CustomizeSelection | null>(null);

  const setActive = useCallback((next: boolean) => {
    setActiveState(next);
    // Leaving the mode drops the selection: a highlighted panel with no
    // inspector beside it is a stuck state with no way to read it.
    if (!next) setSelection(null);
  }, []);

  // The shell reads this to make room for the rail and to mark editable things.
  // An attribute rather than a class because "am I customising" is a fact about
  // the whole document, and every surface that cares can answer it in CSS
  // without threading a prop through the tree.
  useEffect(() => {
    const root = document.documentElement;
    if (active) root.dataset.customizing = "true";
    else delete root.dataset.customizing;
    return () => {
      delete root.dataset.customizing;
    };
  }, [active]);

  // Click-to-select, by delegation.
  //
  // Capture phase and preventDefault, because the things worth customising are
  // usually also links — a panel you click to open is a panel you cannot click
  // to select. In this mode a click means "tell me about this", and the
  // navigation it would otherwise perform is exactly what has to be suppressed.
  useEffect(() => {
    if (!active) return;
    const onClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      // The inspector is not part of the canvas; clicking inside it is
      // ordinary interaction.
      if (target?.closest("[data-customize-rail]")) return;
      const hit = target?.closest<HTMLElement>("[data-customize-id]");
      if (!hit) return;
      event.preventDefault();
      event.stopPropagation();
      setSelection({
        id: hit.dataset.customizeId!,
        label: hit.dataset.customizeLabel || "This panel",
        screenKey: hit.dataset.customizeScreen || null,
      });
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [active]);

  // Escape steps back one level rather than dropping straight out: with a
  // panel selected it deselects, and only then does it leave the mode. Anything
  // else means one stray keypress throws away what you were doing.
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (selection) setSelection(null);
      else setActive(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, selection, setActive]);

  const value = useMemo<CustomizeContextValue>(
    () => ({ active, setActive, selection, select: setSelection }),
    [active, setActive, selection],
  );

  return (
    <CustomizeContext.Provider value={value}>
      {children}
    </CustomizeContext.Provider>
  );
}

/**
 * The customise mode.
 *
 * Falls back to "off, and nothing selectable" outside a provider rather than
 * throwing: a panel rendered in a test, or on a surface with no provider,
 * should render as an ordinary panel.
 */
export function useCustomize(): CustomizeContextValue {
  const ctx = useContext(CustomizeContext);
  if (ctx) return ctx;
  return {
    active: false,
    setActive: () => {},
    selection: null,
    select: () => {},
  };
}

/**
 * Props that make an element selectable while customising.
 *
 * A helper rather than a wrapper component so a panel opts in by spreading
 * three attributes onto the element it already renders — no extra DOM node, and
 * nothing to keep in agreement with the layout.
 */
export function customizable(input: {
  id: string;
  label: string;
  screenKey?: string | null;
}) {
  return {
    "data-customize-id": input.id,
    "data-customize-label": input.label,
    ...(input.screenKey ? { "data-customize-screen": input.screenKey } : {}),
  };
}
