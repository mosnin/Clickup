"use client";

import { PanelLeft } from "lucide-react";
import { useSidebar } from "@/components/ui/sidebar";
import { useAppearance } from "@/components/appearance/appearance-provider";
import { cn } from "@/lib/utils";

// The handle for a floating sidebar.
//
// Only rendered when the sidebar is floating, and only when it is closed:
// every other layout keeps its trigger in the page header, but a floating panel
// slides fully off-screen, and a surface with no header (chat, a full-bleed
// page) would leave someone with no way back to their own navigation.
//
// Fixed to the edge rather than placed in the flow, because "the nav is over
// there" should be true regardless of what the page underneath is doing.

export function FloatingNavToggle() {
  const { appearance } = useAppearance();
  const { open, setOpen, isMobile } = useSidebar();

  if (appearance.sidebarPosition !== "floating") return null;
  if (open || isMobile) return null;

  return (
    <button
      type="button"
      aria-label="Show navigation"
      onClick={() => setOpen(true)}
      className={cn(
        "panel tap-target fixed left-3 top-3 z-50 flex h-9 w-9 items-center justify-center rounded-full",
        "text-muted-foreground transition-colors hover:text-foreground",
      )}
    >
      <PanelLeft className="h-4 w-4" />
    </button>
  );
}
