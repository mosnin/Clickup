import type { Metadata } from "next";
import { ProjectsScreen } from "@/components/chat/projects";

export const metadata: Metadata = { title: "Projects · Chat" };

// `/chat/projects`. The shell around it is the layout's; this route is only the
// screen that sits in the content surface.
//
// No `Suspense` boundary, unlike `/chat/pulse`: this screen reads its community
// from the shell context rather than from `useSearchParams`, so there is nothing
// here that Next needs a boundary to prerender around.

export default function ChatProjects() {
  return <ProjectsScreen />;
}
