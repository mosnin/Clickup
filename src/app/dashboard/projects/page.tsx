import type { Metadata } from "next";
import { ProjectsView } from "./projects-view";

export const metadata: Metadata = {
  title: "Projects",
  robots: { index: false, follow: false },
};

export default function ProjectsPage() {
  return <ProjectsView />;
}
