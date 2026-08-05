"use client";

import { useCallback, useMemo } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import {
  NAV_SCREEN_KEY,
  navLayoutFor,
  navPrefFrom,
  resolveNav,
  type NavItem,
  type NavItemId,
  type NavPref,
} from "@/lib/nav-items";

/**
 * The navigation, resolved.
 *
 * Two reads and one resolver, so the sidebar and the dock get an identical
 * answer from an identical function — the point of moving the nav into data
 * was that the two surfaces stop being able to disagree, and two hooks would
 * hand that back.
 *
 * `scope` names whose default applies. Undefined while the surrounding data
 * loads, which is why the query is skipped rather than called with a guess:
 * a nav that renders the shipped default for a frame and then reshuffles is
 * worse than one that waits, because the reshuffle happens exactly where the
 * pointer already is.
 */
export function useNav(
  scope: { parentType: "user" | "workspace"; parentId: string } | undefined,
  surface: "sidebar" | "dock" = "sidebar",
): {
  items: NavItem[];
  personal: NavPref | null;
  workspaceDefault: NavPref | null;
  save: (pref: NavPref) => Promise<void>;
  reset: () => Promise<void>;
} {
  const stored = useQuery(api.screens.layoutFor, { screenKey: NAV_SCREEN_KEY });
  const workspaceLayout = useQuery(
    api.nav.defaultsFor,
    scope ? scope : "skip",
  );
  const saveLayout = useMutation(api.screens.saveLayout);
  const resetLayout = useMutation(api.screens.resetLayout);

  const personal = useMemo(() => navPrefFrom(stored), [stored]);
  const workspaceDefault = useMemo(
    () => navPrefFrom(workspaceLayout),
    [workspaceLayout],
  );

  const items = useMemo(
    () => resolveNav(personal, workspaceDefault, { surface }),
    [personal, workspaceDefault, surface],
  );

  const save = useCallback(
    async (pref: NavPref) => {
      await saveLayout({
        screenKey: NAV_SCREEN_KEY,
        layout: navLayoutFor(pref),
      });
    },
    [saveLayout],
  );

  // Resetting deletes the personal row rather than writing the current
  // resolved order into it. Materialising the answer looks identical today
  // and silently stops tracking the workspace default tomorrow — the same
  // reason clearing an appearance override deletes the key.
  const reset = useCallback(async () => {
    await resetLayout({ screenKey: NAV_SCREEN_KEY });
  }, [resetLayout]);

  return { items, personal, workspaceDefault, save, reset };
}

/** Toggle one destination for this person, preserving everything else. */
export function toggleNavItem(
  current: NavPref | null,
  visible: NavItemId[],
  id: NavItemId,
): NavPref {
  // Seeded from what is on screen rather than from the shipped order, so a
  // person who has never customised does not silently adopt an arrangement
  // they never saw.
  const order = current?.order.length ? current.order : visible;
  const hidden = new Set(current?.hidden ?? []);
  if (hidden.has(id)) hidden.delete(id);
  else hidden.add(id);
  return { order: [...order], hidden: [...hidden] };
}
