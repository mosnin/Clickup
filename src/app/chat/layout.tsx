import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { AgentOnlineWatcher } from "@/components/dashboard/agent-online-watcher";
import { EnsureUser } from "@/components/dashboard/ensure-user";
import { RequireBackend } from "@/components/require-backend";
import { ToastProvider } from "@/components/toast";
import { AppearanceProvider } from "@/components/appearance/appearance-provider";
import { ChatThemeScope } from "@/components/chat/chat-theme-scope";
import { ChatShell } from "@/components/chat/shell/chat-shell";

// The Chat dashboard's shell.
//
// A sibling of /dashboard, not a route inside it: Chat is a different
// application over the same workspace, with its own navigation, its own
// surfaces and its own visual language. Mounting it under the Work shell would
// mean inheriting a sidebar built to answer a different question, plus the
// canvas customisation gestures (dock, style studio, arrange mode) that belong
// to the Work model and mean nothing in a conversation.
//
// What it deliberately does share, because these are properties of the person
// and not of the dashboard:
//   • ToastProvider     — every write path we reuse reports failure through it
//   • AppearanceProvider — so type size, motion, contrast and body typeface
//                          follow the reader across the switch. A second
//                          instance is safe: the two shells never coexist.
//   • EnsureUser        — someone whose first-ever landing is /chat still needs
//                          a user row and a personal space
//
// The viewport is pinned exactly as the Work shell pins it, for a sharper
// reason: the transcript scrolls, the composer does not. If the document
// scrolls, the composer walks off the bottom of the screen.
//
// The chrome itself — rail, sidebar, top strip — lives in this layout rather
// than in the pages it frames. Two reasons, and both are about the sidebar
// being a subscription and not a picture: a shell rendered per page re-mounts
// on every room you click, which drops and re-opens the channel subscription
// and flashes the rail; and it would make "which room is active" a thing each
// page has to say rather than a thing the URL already knows.

export default async function ChatLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");

  return (
    <RequireBackend>
      <ToastProvider>
        <AppearanceProvider>
          <ChatThemeScope />
          <EnsureUser />
          <AgentOnlineWatcher />
          <ChatShell>{children}</ChatShell>
        </AppearanceProvider>
      </ToastProvider>
    </RequireBackend>
  );
}
