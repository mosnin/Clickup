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
import { SHELL_INSET, SHELL_PAGE, SHELL_PROVIDER } from "@/lib/shell";

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
        {/* The backdrop the window floats on. Fixed and behind everything so
            it survives the slab's own scrolling, and scoped to /dashboard so
            the marketing site keeps its own canvas. */}
        <SidebarProvider defaultOpen={defaultOpen} className={SHELL_PROVIDER}>
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
          <SidebarInset data-mode-surface="content" className={SHELL_INSET}>
            <div className={SHELL_PAGE}>{children}</div>
          </SidebarInset>
          {/* One continuous brand gradient across the entire viewport's bottom
              edge — the single strip of product flair, coherent by
              construction (unlike per-panel strips that restart at seams). */}
          {/* `absolute`, not `fixed`: the strip belongs to the app window's
              bottom edge, and fixed would pin it to the viewport — outside the
              slab, lying on the backdrop. */}
          <div
            aria-hidden
            className="gradient-strip pointer-events-none absolute inset-x-0 bottom-0 z-50"
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
