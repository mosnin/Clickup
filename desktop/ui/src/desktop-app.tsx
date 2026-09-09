import { Suspense, useSyncExternalStore } from "react";
import DashboardHome from "@/app/dashboard/page";
import MyWorkPage from "@/app/dashboard/my-work/page";
import PersonalPage from "@/app/dashboard/personal/page";
import { AdminConsole } from "@/components/dashboard/admin-console";
import { AgentDetail } from "@/app/dashboard/agents/[agentId]/agent-detail";
import { AgentsView } from "@/app/dashboard/agents/agents-view";
import { AppearanceOverview } from "@/app/dashboard/appearance/appearance-overview";
import { ChartsStudio } from "@/app/dashboard/appearance/charts/charts-studio";
import { PanelsStudio } from "@/app/dashboard/appearance/panels/panels-studio";
import { ChatView } from "@/app/dashboard/chat/chat-view";
import { Inbox } from "@/app/dashboard/inbox/inbox-view";
import { ListPage } from "@/app/dashboard/l/[listId]/list-page";
import { ListSettings } from "@/app/dashboard/l/[listId]/settings/list-settings";
import { TaskDetail } from "@/app/dashboard/l/[listId]/t/[taskId]/task-detail";
import { ProjectView } from "@/app/dashboard/p/[projectId]/project-view";
import { PagesIndex } from "@/app/dashboard/pages/pages-index";
import { PageEditor } from "@/app/dashboard/pages/[pageId]/page-editor";
import { ProjectsView } from "@/app/dashboard/projects/projects-view";
import { SpacesView } from "@/app/dashboard/projects/spaces-view";
import { SpaceView } from "@/app/dashboard/s/[spaceId]/space-view";
import { SearchView } from "@/app/dashboard/search/search-view";
import { AppearanceStudio } from "@/app/dashboard/settings/appearance/appearance-studio";
import { TemplateCenter } from "@/app/dashboard/templates/template-center";
import { WorkspaceView } from "@/app/dashboard/w/[workspaceId]/workspace-view";
import { WhiteboardEditor } from "@/app/dashboard/wb/[whiteboardId]/whiteboard-editor";
import { PlanCanvas } from "@/components/dashboard/plan-canvas";
import { ChatThemeScope } from "@/components/chat/chat-theme-scope";
import { ModerationScreen } from "@/components/chat/moderation/moderation-screen";
import { ProjectScreen as ChatProjectScreen, ProjectsScreen } from "@/components/chat/projects";
import { PulseScreen } from "@/components/chat/pulse";
import { ChannelScreen } from "@/components/chat/shell/channel-screen";
import { ChatShell } from "@/components/chat/shell/chat-shell";
import { ChatHomeScreen } from "@/components/chat/shell/home-screen";
import { ChatSettingsScreen } from "@/components/chat/shell/settings-screen";
import { AgentOnlineWatcher } from "@/components/dashboard/agent-online-watcher";
import { DashboardSidebar } from "@/components/dashboard/sidebar";
import { EnsureUser } from "@/components/dashboard/ensure-user";
import { NoSupportWidget } from "@/components/dashboard/no-support-widget";
import { QueryErrorBoundary } from "@/components/dashboard/query-error-boundary";
import { CommandPalette } from "@/components/command-palette";
import { ToastProvider } from "@/components/toast";
import { AppearanceProvider } from "@/components/appearance/appearance-provider";
import { CustomizeProvider } from "@/components/appearance/customize-provider";
import { DockSlot } from "@/components/appearance/dock-slot";
import { FloatingNavToggle } from "@/components/appearance/floating-nav-toggle";
import { MintablePanelsProvider } from "@/components/appearance/mintable-panels";
import { SidebarDock } from "@/components/appearance/sidebar-dock";
import { StyleStudio } from "@/components/appearance/style-studio";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { RequireBackend } from "@/components/require-backend";
import { SHELL_INSET, SHELL_PAGE, SHELL_PROVIDER } from "@/lib/shell";

function subscribe(callback: () => void) {
  addEventListener("popstate", callback);
  return () => removeEventListener("popstate", callback);
}

function snapshot() {
  return `${location.pathname}${location.search}`;
}

function match(pathname: string, expression: RegExp) {
  return pathname.match(expression)?.slice(1).map(decodeURIComponent);
}

function NativeRoute() {
  useSyncExternalStore(subscribe, snapshot);
  const path = location.pathname === "/" ? "/dashboard" : location.pathname;
  const query = new URLSearchParams(location.search);
  let ids: string[] | undefined;

  if (path === "/dashboard") return <DashboardHome />;
  if (path === "/dashboard/my-work") return <MyWorkPage />;
  if (path === "/dashboard/personal") return <PersonalPage />;
  if (path === "/dashboard/admin") return <AdminConsole />;
  if (path === "/dashboard/agents") return <AgentsView />;
  if ((ids = match(path, /^\/dashboard\/agents\/([^/]+)$/))) return <AgentDetail agentId={ids[0]} />;
  if (path === "/dashboard/appearance") return <AppearanceOverview />;
  if (path === "/dashboard/appearance/charts") return <ChartsStudio />;
  if (path === "/dashboard/appearance/panels") return <PanelsStudio />;
  if (path === "/dashboard/chat") return <ChatView />;
  if (path === "/dashboard/inbox") return <Inbox />;
  if (path === "/dashboard/pages") return <PagesIndex />;
  if ((ids = match(path, /^\/dashboard\/pages\/([^/]+)$/))) return <PageEditor pageId={ids[0]} />;
  if (path === "/dashboard/projects") return <ProjectsView />;
  if (path === "/dashboard/spaces") return <SpacesView />;
  if (path === "/dashboard/search") return <SearchView initialQuery={query.get("q") ?? ""} />;
  if (path === "/dashboard/templates") return <TemplateCenter />;
  if (path === "/dashboard/settings/appearance") {
    history.replaceState({}, "", "/dashboard/appearance");
    return <AppearanceOverview />;
  }
  if ((ids = match(path, /^\/dashboard\/w\/([^/]+)$/))) return <WorkspaceView workspaceId={ids[0]} />;
  if ((ids = match(path, /^\/dashboard\/s\/([^/]+)\/appearance$/))) return <AppearanceStudio />;
  if ((ids = match(path, /^\/dashboard\/s\/([^/]+)$/))) return <SpaceView spaceId={ids[0]} />;
  if ((ids = match(path, /^\/dashboard\/p\/([^/]+)\/plan$/))) return <PlanCanvas projectId={ids[0]} />;
  if ((ids = match(path, /^\/dashboard\/p\/([^/]+)$/))) return <ProjectView projectId={ids[0]} />;
  if ((ids = match(path, /^\/dashboard\/l\/([^/]+)\/settings$/))) return <ListSettings listId={ids[0]} />;
  if ((ids = match(path, /^\/dashboard\/l\/([^/]+)\/t\/([^/]+)$/))) return <TaskDetail listId={ids[0]} taskId={ids[1]} />;
  if ((ids = match(path, /^\/dashboard\/l\/([^/]+)$/))) return <ListPage listId={ids[0]} initialView={query.get("view") ?? undefined} />;
  if ((ids = match(path, /^\/dashboard\/wb\/([^/]+)$/))) return <WhiteboardEditor whiteboardId={ids[0]} />;

  return <section className="panel rounded-2xl p-8"><h1 className="text-xl font-bold">This route is not available in this build.</h1><p className="mt-2 text-sm text-muted-foreground">Return to the dashboard and try again.</p></section>;
}

function NativeChatRoute() {
  useSyncExternalStore(subscribe, snapshot);
  const path = location.pathname;
  let ids: string[] | undefined;
  if (path === "/chat") return <ChatHomeScreen />;
  if (path === "/chat/projects") return <ProjectsScreen />;
  if ((ids = match(path, /^\/chat\/projects\/(.+)$/))) return <ChatProjectScreen projectId={ids[0]} />;
  if (path === "/chat/pulse") return <PulseScreen />;
  if (path === "/chat/settings") return <ChatSettingsScreen />;
  if (path === "/chat/moderation") return <ModerationScreen />;
  if ((ids = match(path, /^\/chat\/c\/([^/]+)$/))) return <ChannelScreen channelId={ids[0]} />;
  return <ChatHomeScreen />;
}

function NativeChatApp() {
  return (
    <RequireBackend>
      <ToastProvider>
        <AppearanceProvider>
          <CustomizeProvider>
            <ChatThemeScope />
            <EnsureUser />
            <AgentOnlineWatcher />
            <ChatShell><Suspense fallback={null}><NativeChatRoute /></Suspense></ChatShell>
            <StyleStudio />
          </CustomizeProvider>
        </AppearanceProvider>
      </ToastProvider>
    </RequireBackend>
  );
}

export function DesktopApp() {
  useSyncExternalStore(subscribe, snapshot);
  if (location.pathname.startsWith("/chat")) return <NativeChatApp />;
  const defaultOpen = localStorage.getItem("sidebar_state") !== "false";
  return (
    <RequireBackend>
      <ToastProvider>
        <AppearanceProvider>
          <CustomizeProvider>
            <MintablePanelsProvider>
              <SidebarProvider defaultOpen={defaultOpen} className={SHELL_PROVIDER}>
                <EnsureUser />
                <NoSupportWidget />
                <CommandPalette />
                <AgentOnlineWatcher />
                <DashboardSidebar />
                <SidebarInset data-mode-surface="content" className={SHELL_INSET}>
                  <div className={SHELL_PAGE}>
                    <QueryErrorBoundary><Suspense fallback={null}><NativeRoute /></Suspense></QueryErrorBoundary>
                  </div>
                </SidebarInset>
                <FloatingNavToggle />
                <SidebarDock />
                <DockSlot />
                <StyleStudio />
              </SidebarProvider>
            </MintablePanelsProvider>
          </CustomizeProvider>
        </AppearanceProvider>
      </ToastProvider>
    </RequireBackend>
  );
}
