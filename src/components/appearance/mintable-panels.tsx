"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { widgetIdFromSelection } from "@/lib/built-in-panel";
import type { PanelDef } from "@/lib/panel";

// How a built-in panel becomes yours.
//
// A built-in has no definition to edit, so the only way "draw this as a donut"
// can mean anything is for the pick to MINT one — a real panel, in the reader's
// own collection, asking the built-in's question in the shape they chose — and
// put it exactly where the built-in stood.
//
// The awkward part, and the reason this is a registry rather than something the
// studio does by itself: minting is a server call, placing is not. The server
// cannot tell "never arranged this screen" from "arranged it empty" (see the
// note on `panelProposals` in convex/uiComponents.ts), so a mutation that also
// wrote a layout row would wipe a screen down to the one panel it just made.
// The mutation returns an id and the CLIENT places it — and the client that
// knows where is the screen, which is already holding its own layout, its own
// store and its own scope. Home keeps its arrangement in
// `userSettings.homeWidgets`, a project screen in `screenLayouts`; neither
// answer belongs in the studio.
//
// Registry rather than plain context because of where the two ends sit: the
// studio is mounted in the dashboard LAYOUT, beside the page rather than below
// it, so a provider rendered by the page could never reach it. The provider
// goes up in the layout and the page offers itself into it.
//
// The offer is held in a ref, deliberately. The screen's `replace` closes over
// its current layout, so it changes identity on every render; a context value
// carrying it would re-render the studio on every keystroke anywhere on the
// page. The ref is re-pointed each render and read at CLICK time, which is the
// only moment its freshness matters. Only the grid's identity — which screen is
// offering, if any — is state, because that is the one thing the studio has to
// re-render for.
//
// A page that offers nothing is the default. The studio then says the shape is
// fixed, which is true.

export type MintableScreen = {
  /** Which grid these widget ids belong to — the studio only reads its own. */
  gridId: string;
  /** Where a minted panel is stored, and what data it resolves against. */
  scope: { scopeType: "user" | "workspace"; scopeId: string };
  /**
   * The question a built-in asks, or null where the vocabulary cannot state it.
   * See src/lib/built-in-panel.ts for which, and why.
   */
  questionFor: (widgetId: string) => PanelDef | null;
  /** Put the minted panel where the built-in stood. */
  replace: (widgetId: string, componentId: string) => void;
};

type Registry = {
  offer: RefObject<MintableScreen | null>;
  /** The offering grid, as state — the studio re-renders when this changes. */
  gridId: string | null;
  claim: (gridId: string) => void;
  release: (gridId: string) => void;
};

const MintableContext = createContext<Registry | null>(null);

export function MintablePanelsProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const offer = useRef<MintableScreen | null>(null);
  const [gridId, setGridId] = useState<string | null>(null);
  const claim = useCallback((id: string) => setGridId(id), []);
  // Release only what you claimed. Route transitions overlap — the arriving
  // screen mounts before the leaving one unmounts — so an unconditional clear
  // on unmount would wipe the offer the NEW screen had just registered and
  // leave the studio saying the shape is fixed on a screen where it isn't.
  const release = useCallback(
    (id: string) => setGridId((cur) => (cur === id ? null : cur)),
    [],
  );
  const value = useMemo<Registry>(
    () => ({ offer, gridId, claim, release }),
    [gridId, claim, release],
  );
  return (
    <MintableContext.Provider value={value}>
      {children}
    </MintableContext.Provider>
  );
}

/**
 * Offer this screen's built-ins to the studio.
 *
 * Called with a fresh object every render — that is the point; see the note
 * above. Pass null from a screen with nothing to offer.
 */
export function useOfferMintablePanels(screen: MintableScreen | null): void {
  const registry = useContext(MintableContext);
  const gridId = screen?.gridId ?? null;

  // No dependency array: the offer has to be the one from THIS render, and the
  // whole reason it is a ref is that its identity changes constantly.
  useLayoutEffect(() => {
    if (registry) registry.offer.current = screen;
  });

  useEffect(() => {
    if (!registry || !gridId) return;
    registry.claim(gridId);
    return () => {
      // Leaving the page takes the offer with it, or the studio would keep
      // offering to mint from a screen that is no longer on the display and
      // write into a layout nobody is looking at.
      if (registry.offer.current?.gridId === gridId) {
        registry.offer.current = null;
      }
      registry.release(gridId);
    };
  }, [registry, gridId]);
}

/**
 * What the studio can mint for the currently selected built-in, if anything.
 *
 * `selectionId` is `<gridId>:<widgetId>` — the id `customizable()` writes onto
 * a tile. Split on the FIRST colon only, because a panel's own widget id
 * carries one (`custom:<id>`).
 *
 * Answers null rather than throwing outside a provider: a surface with no
 * mintable built-ins and a surface with no provider should look the same from
 * here, and both mean "the shape is fixed".
 */
export function useMintableBuiltIn(selectionId: string | null): {
  question: PanelDef;
  scope: MintableScreen["scope"];
  replace: (componentId: string) => void;
} | null {
  const registry = useContext(MintableContext);
  const widgetId = widgetIdFromSelection(selectionId, registry?.gridId ?? null);
  const screen = registry?.offer.current ?? null;
  const question = widgetId && screen ? screen.questionFor(widgetId) : null;
  if (!registry || !widgetId || !screen || !question) return null;
  return {
    question,
    scope: screen.scope,
    // Read through the ref at call time: the screen's layout has almost
    // certainly changed since this was rendered, and writing a stale one back
    // would undo whatever moved in between.
    replace: (componentId: string) =>
      registry.offer.current?.replace(widgetId, componentId),
  };
}
