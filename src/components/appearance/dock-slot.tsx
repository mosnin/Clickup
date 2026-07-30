"use client";

import { useAppearance } from "@/components/appearance/appearance-provider";
import { AppDock } from "@/components/appearance/app-dock";

/**
 * The dock, when the nav lives at the bottom.
 *
 * Split out so the shell's server layout can mount it unconditionally while the
 * decision stays with the appearance provider — which is where "where does this
 * person's nav live" is already answered.
 */
export function DockSlot() {
  const { appearance } = useAppearance();
  if (appearance.sidebarPosition !== "dock") return null;
  return <AppDock />;
}
