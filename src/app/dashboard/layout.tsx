import { auth } from "@clerk/nextjs/server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { DashboardSidebar } from "@/components/dashboard/sidebar";
import { EnsureUser } from "@/components/dashboard/ensure-user";
import { ToastProvider } from "@/components/toast";
import { CommandPalette } from "@/components/command-palette";
import { AgentOnlineWatcher } from "@/components/dashboard/agent-online-watcher";
import { NoSupportWidget } from "@/components/dashboard/no-support-widget";
import { RequireBackend } from "@/components/require-backend";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { AppearanceProvider } from "@/components/appearance/appearance-provider";
import { FloatingNavToggle } from "@/components/appearance/floating-nav-toggle";
import { SidebarDock } from "@/components/appearance/sidebar-dock";
import { DockSlot } from "@/components/appearance/dock-slot";
import { CustomizeProvider } from "@/components/appearance/customize-provider";
import { MintablePanelsProvider } from "@/components/appearance/mintable-panels";
import { StyleStudio } from "@/components/appearance/style-studio";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");

  // Read the vendored sidebar's own persistence cookie so the collapsed/
  // expanded state survives a full page load instead of flashing open every
  // time (M3). Name/values must match SIDEBAR_COOKIE_NAME in
  // src/components/ui/sidebar.tsx, which writes "true"/"false" strings.
  const cookieStore = await cookies();
  const sidebarCookie = cookieStore.get("sidebar_state")?.value;
  const defaultOpen = sidebarCookie !== "false";

  // Square UI dashboard-5 shell: exactly ONE SidebarProvider for the whole
  // dashboard (DashboardSidebar renders only the <Sidebar>, no provider of
  // its own — see its top comment). The provider wrapper is pinned to the
  // viewport height with overflow hidden so SidebarInset — not the document
  // — is the real scroll container; that's what lets PageHeader's
  // `sticky top-0` actually stick (M1). Pages own their own sticky headers
  // and content padding; this shell only owns the scroll container.
  return (
    <RequireBackend>
      {/* Appearance wraps everything: it writes the per-user design tokens
          onto :root, so every surface below it — including the toasts and the
          command palette — renders in the user's own UI. */}
      {/* Toasts wrap appearance, not the other way round: the appearance
          writer needs to be able to say a save failed, and it cannot reach a
          provider mounted below it. */}
      <ToastProvider>
      <AppearanceProvider>
      <CustomizeProvider>
      {/* Above the page rather than inside it: the studio is a sibling of
          `children`, so a screen offering its built-ins for minting has to
          reach up here to be heard. */}
      <MintablePanelsProvider>
        <SidebarProvider defaultOpen={defaultOpen} className="h-svh overflow-hidden">
          <EnsureUser />
          <NoSupportWidget />
          <CommandPalette />
          <AgentOnlineWatcher />
          <DashboardSidebar />
          {/* overflow-x-hidden: SidebarInset is the app's real scroll
              container; without it, any too-wide child would let the whole
              "page" pan sideways on mobile. Wide surfaces (tables, boards,
              Gantt) scroll inside their own overflow-x-auto wrappers. */}
          {/* data-mode-surface: the Work half of the Work ⇄ Chat transition.
              The Chat shell tags its own rail and body with the same two
              values, which is what lets the browser morph one shell's
              navigation into the other's instead of cross-fading the whole
              viewport. See the transition block in globals.css. */}
          {/* The canvas is TINTED, and the cards on it are not.
              This sheet was `bg-background` — white — while every card on it
              is `bg-card`, also white. So a card had nothing to sit on and
              only its 1px border said where it ended, which is why the
              surfaces read as flat next to a design that floats them, and
              why removing those borders in favour of the bento shadow made
              cards disappear entirely rather than lift.
              `bg-page` is the same relationship Chat already has and the one
              thing all three design references share: a soft canvas with
              content floating above it. It is one line, and it is what makes
              `.bento` mean anything at all. */}
          <SidebarInset
            data-mode-surface="content"
            className="h-full min-w-0 overflow-y-auto overflow-x-hidden overscroll-x-contain bg-page"
          >
            <div className="w-full px-4 py-6 sm:px-6">{children}</div>
          </SidebarInset>
          {/* One continuous brand gradient across the entire viewport's bottom
              edge — the single strip of product flair, coherent by
              construction (unlike per-panel strips that restart at seams). */}
          <div
            aria-hidden
            className="gradient-strip pointer-events-none fixed inset-x-0 bottom-0 z-50"
          />
          {/* The way back to the nav when it is floating and hidden. A
              floating sidebar that can be dismissed with no visible way to
              return is a trap, and the shell's own trigger lives inside the
              page headers — which is exactly what a full-bleed surface
              doesn't have. */}
          <FloatingNavToggle />
          {/* Hold the sidebar for a moment and drag it: dock left, dock
              right, or tear it out to float. The setting IS the drag. */}
          <SidebarDock />
          {/* Dragged to the bottom, the nav stops being a sidebar and becomes
              a dock — a different shape, not the same one rotated. */}
          <DockSlot />
          {/* The inspector. Beside the work, never instead of it. */}
          <StyleStudio />
        </SidebarProvider>
      </MintablePanelsProvider>
      </CustomizeProvider>
      </AppearanceProvider>
      </ToastProvider>
    </RequireBackend>
  );
}
